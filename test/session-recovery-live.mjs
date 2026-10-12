// Opt-in: starts its own disposable SDK process. Never attaches to a running user host.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { AgentDatabase } from "../dist/database.js";
import { AssistantResponseCorrelation, CopilotRuntime } from "../dist/runtime.js";
import { SessionEventOrder } from "../dist/session-event-order.js";
import { SessionHealth } from "../dist/session-health.js";

const cliIndex = process.argv.indexOf("--cli");
assert.ok(cliIndex >= 0 && process.argv[cliIndex + 1], "Pass --cli <executable> explicitly.");
const artifacts = resolve(".e2e-artifacts", "session-recovery-live");
mkdirSync(artifacts, { recursive: true });
const directory = mkdtempSync(join(artifacts, "probe-"));
const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
db.createAgentRun("probe-run", "probe-agent", "worker", "{}", directory, process.pid);
const emitted = [];
const runtime = new CopilotRuntime(directory, db, (type, payload) => emitted.push({ type, payload }));
clearInterval(runtime.recoveryTimer);
const client = new CopilotClient({
  workingDirectory: directory,
  connection: RuntimeConnection.forStdio({ path: resolve(process.argv[cliIndex + 1]) }),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const gateEntered = deferred();
const gateResult = deferred();
const pageCaptured = deferred();
const pageRelease = deferred();
let session;
let unsubscribe = () => {};
let missedIdle;
let dropAll = false;
let idles = 0;
let idleWait = deferred();
let toolCalls = 0;
let pageReads = 0;
let sends = 0;
let historyReads = 0;
let live;
let timeout;
const deadline = new Promise((_, reject) => {
  timeout = setTimeout(() => reject(new Error("Isolated SDK recovery probe timed out")), 120_000);
});
const wait = (promise) => Promise.race([promise, deadline]);
const result = { directory, success: false, usesExistingHost: false };
try {
  await wait(client.start());
  session = await wait(client.createSession({
    workingDirectory: directory,
    enableConfigDiscovery: false,
    enableFileHooks: false,
    mcpServers: {},
    disabledMcpServers: ["github-mcp-server"],
    availableTools: ["ordering_probe_gate"],
    streaming: true,
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
    tools: [{
      name: "ordering_probe_gate",
      description: "Harmless test synchronization gate; returns immediately when the test releases it.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      skipPermission: true,
      handler: async () => {
        toolCalls += 1;
        gateEntered.resolve();
        await gateResult.promise;
        return { textResultForLlm: "Gate released.", resultType: "success" };
      },
    }],
  }));
  result.sessionId = session.sessionId;
  const cursor = (await wait(session.rpc.eventLog.tail())).cursor;
  const history = await wait(session.getEvents());
  historyReads += 1;
  session.getEvents = () => assert.fail("No full-history recovery allowed after initialization.");
  const read = session.rpc.eventLog.read;
  session.rpc.eventLog.read = async (request) => {
    pageReads += 1;
    const page = await read(request);
    if (pageReads === 1) {
      assert.ok(page.events.some((event) => event.id === missedIdle.id), "First cursor page must include missed A idle");
      pageCaptured.resolve();
      await pageRelease.promise;
    }
    return page;
  };
  const send = session.send.bind(session);
  session.send = (...args) => { sends += 1; return send(...args); };
  live = {
    session, binding: {}, runId: "probe-run", agentId: "probe-agent", target: "agent:probe-agent",
    generation: 1, alias: "probe", busy: false, foregroundBusy: false,
    foregroundTurnSequence: 0, sequence: 0, idleCycle: 0, lastEventAt: Date.now(),
    lastRecoveryAt: 0, recoveringEvents: false, recoveryCursor: cursor,
    recoveryPermissionRequests: new Map(), recoveryOrderingWarning: false, recoveryOrderingRevision: -1,
    seenEventIds: new Set(history.map((event) => event.id)),
    historicalToolResults: new Map(), aicUsed: 0,
    health: new SessionHealth(() => {}), eventOrder: new SessionEventOrder(),
    responseCorrelation: new AssistantResponseCorrelation(),
  };
  live.eventOrder.recordHistory(history);
  runtime.live.set(live.target, live);
  runtime.agentGenerations.set(live.agentId, 1);
  runtime.liveConnectionCurrent = (candidate) => runtime.live.get(live.target) === candidate;
  runtime.refreshTasks = () => {};
  let drains = 0;
  runtime.scheduleMailboxDrain = () => { drains += 1; };
  unsubscribe = session.on((event) => {
    if (event.type === "session.idle") {
      idles += 1;
      if (!missedIdle) missedIdle = event;
      else if (!dropAll) runtime.handleSessionEvent(live, event);
      idleWait.resolve();
      return;
    }
    if (!dropAll) runtime.handleSessionEvent(live, event);
  });
  await wait(runtime.sendUserPromptOnLive(live, "Reply exactly FIRST. Do not use tools.", true));
  await wait(idleWait.promise);
  assert.equal(idles, 1);
  const recovery = runtime.recoverSilentSession(live);
  await wait(pageCaptured.promise);
  idleWait = deferred();
  await wait(runtime.sendUserPromptOnLive(live,
    "Call ordering_probe_gate exactly once. After it returns, reply exactly SECOND.", true));
  await wait(gateEntered.promise);
  assert.equal(live.foregroundBusy, true);
  pageRelease.resolve();
  await wait(recovery);
  assert.equal(live.foregroundBusy, true, "Old A idle must not clear B while its tool is genuinely running");
  assert.equal(drains, 0);
  await wait(runtime.recoverSilentSession(live));
  assert.equal(live.foregroundBusy, true);
  gateResult.resolve();
  await wait(idleWait.promise);
  assert.equal(live.foregroundBusy, false);
  assert.equal(toolCalls, 1);
  await wait(runtime.recoverSilentSession(live));
  assert.equal(live.eventOrder.pending, 0, "new B evidence must reconcile any deferred A event");
  assert.equal(emitted.filter((entry) =>
    entry.type === "recovery.historical_event" && entry.payload.eventId === missedIdle.id
  ).length, 1);

  dropAll = true;
  idleWait = deferred();
  await wait(runtime.sendUserPromptOnLive(live, "Reply exactly THIRD. Do not use tools.", true));
  await wait(idleWait.promise);
  assert.equal(live.health.waiting, true);
  await wait(runtime.recoverSilentSession(live));
  assert.equal(live.health.waiting, false);
  assert.equal(live.foregroundBusy, false);
  assert.equal(live.eventOrder.pending, 0);
  assert.equal(emitted.filter((entry) =>
    entry.type === "conversation.message" && entry.payload.content?.trim() === "THIRD"
  ).length, 1);
  assert.equal(sends, 3);
  Object.assign(result, {
    success: true, sends, toolCalls, pageReads, historyReads,
    staleIdlePreservedAsHistorical: true,
    activeNewTurnSurvivedOldTerminal: true,
    missingTurnRecoveredExactlyOnce: true,
    queuedEvents: live.eventOrder.pending,
  });
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  clearTimeout(timeout);
  gateResult.resolve();
  pageRelease.resolve();
  unsubscribe();
  runtime.live.clear();
  try {
    if (session) await session.disconnect();
  } finally {
    await client.stop();
    db.close();
    writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
}
