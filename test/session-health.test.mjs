import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { AssistantResponseCorrelation, CopilotRuntime } from "../dist/runtime.js";
import { SessionHealth } from "../dist/session-health.js";

function event(type, id, data = {}) {
  return { type, id, data, timestamp: "2026-10-12T19:49:12.072Z", parentId: null };
}

function clock() {
  let now = Date.now();
  const records = [];
  const health = new SessionHealth((entry) => records.push(entry), () => now);
  return { health, records, advance: (ms) => { now += ms; } };
}

function fixture(t) {
  const artifacts = resolve(".e2e-artifacts", "session-health-tests");
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "case-"));
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  db.createAgentRun("run", "agent", "worker", "{}", directory, process.pid);
  const emitted = [];
  const runtime = new CopilotRuntime(directory, db, (type, payload) => emitted.push({ type, payload }));
  clearInterval(runtime.recoveryTimer);
  const timer = clock();
  let sends = 0;
  let reads = 0;
  const live = {
    runId: "run", agentId: "agent", target: "agent:agent", generation: 1,
    binding: {}, busy: false, foregroundBusy: false, foregroundTurnSequence: 0,
    idleCycle: 0, sequence: 0, seenEventIds: new Set(), lastRecoveryAt: 0,
    lastEventAt: 0, recoveringEvents: false, recoveryCursor: "initial-tail",
    recoveryPermissionRequests: new Map(), health: timer.health,
    responseCorrelation: new AssistantResponseCorrelation(),
    session: {
      sessionId: "session",
      send: async () => { sends += 1; return "sdk-message"; },
      getEvents: () => assert.fail("recovery must not reload the full transcript"),
      rpc: {
        eventLog: {
          read: async (request) => {
            reads += 1;
            assert.equal(request.cursor, "initial-tail");
            assert.equal(request.max, 200);
            return { events: [], cursor: "initial-tail", hasMore: false, cursorStatus: "ok" };
          },
        },
        permissions: { pendingRequests: async () => ({ items: [] }) },
      },
    },
  };
  runtime.live.set(live.target, live);
  runtime.agentGenerations.set(live.agentId, 1);
  runtime.liveConnectionCurrent = (candidate) => runtime.live.get(live.target) === candidate;
  runtime.scheduleMailboxDrain = () => {};
  runtime.refreshTasks = () => {};
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...timer, runtime, live, db, emitted,
    sends: () => sends, reads: () => reads,
  };
}

test("accepted prompt missing turn_start is polled and warned without redelivery", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "PRIVATE PROMPT", true);
  assert.equal(f.health.waiting, true);
  f.advance(60_000);
  await f.runtime.recoverSilentSessions();
  assert.equal(f.reads(), 1);
  assert.equal(f.sends(), 1);
  assert.equal(f.emitted.filter((e) => e.type === "member.stalled").length, 1);
  assert.equal(f.emitted.find((e) => e.type === "prompt.accepted").payload.sdkMessageId, "sdk-message");
  assert.equal(f.live.busy, false, "watchdog must not synthesize busy or idle");
  assert.equal(JSON.stringify(f.records).includes("PRIVATE PROMPT"), false);
  assert.equal(f.records.find((e) => e.operation === "send.accepted").sdkMessageId, "sdk-message");
});

test("missing start and response notifications are recovered from an idle host state", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "prompt", true);
  f.live.session.rpc.eventLog.read = async () => ({
    events: [
      event("assistant.turn_start", "start", { turnId: "0" }),
      event("assistant.message", "message", { messageId: "reply", content: "Done", turnId: "0" }),
      event("assistant.turn_end", "end", { turnId: "0" }),
      event("session.idle", "idle"),
    ],
    cursor: "next", hasMore: false, cursorStatus: "ok",
  });
  f.advance(10_000);
  await f.runtime.recoverSilentSessions();
  assert.equal(f.emitted.filter((e) => e.type === "conversation.message").length, 1);
  assert.equal(f.health.waiting, false);
  assert.equal(f.live.busy, false);
  assert.equal(f.sends(), 1);
});

test("hung recovery cannot suppress the independent warning or launch overlapping reads", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "prompt", true);
  f.runtime.handleSessionEvent(f.live, event("assistant.turn_start", "start", { turnId: "0" }));
  let finish;
  let reads = 0;
  f.live.session.rpc.eventLog.read = () => {
    reads += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  f.advance(10_000);
  const pending = f.runtime.recoverSilentSessions();
  assert.equal(f.live.recoveringEvents, true);
  f.advance(50_000);
  await f.runtime.recoverSilentSessions();
  assert.equal(reads, 1);
  const warning = f.emitted.find((e) => e.type === "member.stalled");
  assert.equal(warning.payload.recoveryPhase, "events");
  assert.equal(warning.payload.recoveryElapsedMs, 50_000);
  assert.equal(f.live.busy, true);
  assert.equal(f.sends(), 1);
  finish({
    events: [event("session.idle", "idle")],
    cursor: "next", hasMore: false, cursorStatus: "ok",
  });
  await pending;
  assert.equal(f.live.busy, false);
  assert.equal(f.live.recoveringEvents, false);
  assert.equal(f.health.snapshot().stalled, false);
  assert.equal(f.emitted.filter((e) => e.type === "member.progress").length, 1);
});

test("missing completion is replayed once, including expired-cursor overlaps", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "prompt", true);
  const start = event("assistant.turn_start", "start", { turnId: "0" });
  f.runtime.handleSessionEvent(f.live, start);
  const events = [
    start,
    event("assistant.message", "message", { messageId: "reply", content: "Done", turnId: "0" }),
    event("assistant.turn_end", "end", { turnId: "0" }),
    event("session.idle", "idle"),
  ];
  f.live.session.rpc.eventLog.read = async () => ({
    events, cursor: "next", hasMore: false, cursorStatus: "expired",
  });
  await f.runtime.recoverSilentSession(f.live);
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.emitted.filter((e) => e.type === "conversation.message").length, 1);
  assert.equal(f.emitted.filter((e) => e.type === "member.foreground_idle").length, 1);
  assert.equal(f.live.busy, false);
  assert.equal(f.sends(), 1);
});

test("permanently pending recovery stays single-outstanding and does not flood warnings", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "prompt", true);
  f.runtime.handleSessionEvent(f.live, event("assistant.turn_start", "start", { turnId: "0" }));
  let reads = 0;
  f.live.session.rpc.eventLog.read = () => {
    reads += 1;
    return new Promise(() => {});
  };
  f.advance(10_000);
  void f.runtime.recoverSilentSessions();
  for (let second = 0; second < 350; second += 10) {
    f.advance(10_000);
    await f.runtime.recoverSilentSessions();
  }
  assert.equal(reads, 1);
  assert.equal(f.emitted.filter((entry) => entry.type === "member.stalled").length, 2);
  assert.equal(f.live.recoveringEvents, true);
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.sends(), 1);
});

test("healthy long-running tool progress neither warns nor synthesizes completion", async (t) => {
  const f = fixture(t);
  await f.runtime.sendUserPromptOnLive(f.live, "prompt", true);
  f.runtime.handleSessionEvent(f.live, event("assistant.turn_start", "start", { turnId: "0" }));
  f.runtime.handleSessionEvent(f.live, event("tool.execution_start", "tool", {
    toolCallId: "tool", toolName: "powershell",
  }));
  for (let minute = 0; minute < 10; minute += 1) {
    f.advance(59_000);
    f.runtime.handleSessionEvent(f.live, event("tool.execution_progress", `progress-${minute}`, {
      toolCallId: "tool", progressMessage: "Still running",
    }));
    await f.runtime.recoverSilentSessions();
  }
  assert.equal(f.emitted.some((entry) => entry.type === "member.stalled"), false);
  assert.equal(f.emitted.some((entry) => entry.type === "member.foreground_idle"), false);
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.sends(), 1);
});

test("failed recovery records metadata, surfaces its error, and remains retryable", async (t) => {
  const f = fixture(t);
  f.live.busy = true;
  f.live.session.rpc.eventLog.read = async () => { throw new Error("transport closed"); };
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.live.recoveringEvents, false);
  assert.equal(f.live.busy, true);
  assert.match(f.emitted.find((e) => e.type === "tasks.error").payload.message, /transport closed/);
  assert.equal(f.records.at(-1).operation, "recovery.failed");
  assert.equal(JSON.stringify(f.records).includes("transport closed"), false);
});

test("bounds catch-up pages and does not deny a permission before its page arrives", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.live.session.rpc.eventLog.read = async () => ({
    events: [], cursor: `page-${++reads}`, hasMore: true, cursorStatus: "ok",
  });
  f.live.session.rpc.permissions.pendingRequests = () => assert.fail("history is not caught up");
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 5);
  assert.equal(f.live.recoveryCursor, "page-5");
  assert.equal(f.live.recoveringEvents, false);
  assert.equal(f.health.snapshot().recoveryPhase, "paused");
});

test("incremental recovery retains original permission policy inputs until completion", async (t) => {
  const f = fixture(t);
  const request = { kind: "read", path: "E:\\allowed\\document.txt" };
  const answers = [];
  f.runtime.agents.set("agent", { agent: { permission: {} } });
  f.runtime.evaluatePermissionRequest = async (_policy, _binding, actual) => {
    assert.deepEqual(actual, request);
    return { kind: "respond", response: { kind: "approved" } };
  };
  f.live.session.rpc.permissions.pendingRequests = async () => ({
    items: [{ requestId: "permission" }],
  });
  f.live.session.rpc.permissions.handlePendingPermissionRequest = async (answer) => { answers.push(answer); };
  f.live.session.rpc.eventLog.read = async () => ({
    events: [event("permission.requested", "request", { requestId: "permission", permissionRequest: request })],
    cursor: "next", hasMore: false, cursorStatus: "ok",
  });
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(answers[0].result.kind, "approved");
  assert.deepEqual(f.live.recoveryPermissionRequests.get("permission"), request);
  f.runtime.handleSessionEvent(f.live, event("permission.completed", "completion", { requestId: "permission" }));
  assert.equal(f.live.recoveryPermissionRequests.size, 0);
  f.live.session.rpc.permissions.pendingRequests = async () => ({ items: [{ requestId: "unknown" }] });
  await f.runtime.recoverSilentSession(f.live);
  assert.notEqual(answers[1].result.kind, "approved", "unknown original inputs must fail closed");
});

test("foreground response after steering does not warn merely because background work remains", async (t) => {
  const f = fixture(t);
  f.runtime.handleSessionEvent(f.live, event("assistant.turn_start", "start", { turnId: "0" }));
  await f.runtime.sendUserPromptOnLive(f.live, "steering prompt", true);
  f.runtime.handleSessionEvent(f.live, event("assistant.message", "reply", {
    messageId: "reply", content: "Done", turnId: "0",
  }));
  f.runtime.handleSessionEvent(f.live, event("assistant.turn_end", "end", { turnId: "0" }));
  assert.equal(f.live.foregroundBusy, false);
  assert.equal(f.live.busy, true);
  assert.equal(f.health.waiting, false);
  f.advance(60_000);
  await f.runtime.recoverSilentSessions();
  assert.equal(f.emitted.some((e) => e.type === "member.stalled"), false);
});

test("late recovery after a warning cannot mutate a replacement connection and turn", async (t) => {
  const f = fixture(t);
  let finish;
  f.live.session.rpc.eventLog.read = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.runtime.recoverSilentSession(f.live);
  f.health.sendStarted("old-request");
  f.advance(60_000);
  assert.ok(f.health.check(true));
  const replacement = {
    ...f.live, generation: 2, recoveryCursor: "replacement-tail",
    busy: true, foregroundBusy: true, foregroundTurnId: "new-turn",
  };
  f.runtime.live.set(f.live.target, replacement);
  finish({ events: [event("session.idle", "idle")], cursor: "next", hasMore: false });
  await pending;
  assert.equal(f.emitted.length, 0);
  assert.equal(f.live.recoveryCursor, "initial-tail");
  assert.equal(replacement.recoveryCursor, "replacement-tail");
  assert.equal(replacement.foregroundBusy, true);
  assert.equal(replacement.foregroundTurnId, "new-turn");
});

test("warnings are rate limited, ignore idle sessions, and survive heartbeat traffic", () => {
  const f = clock();
  f.advance(60_000);
  assert.equal(f.health.check(false), undefined);
  f.health.sendStarted("request");
  f.health.sendSettled("request", "sdk");
  f.advance(59_999);
  assert.equal(f.health.check(false), undefined);
  f.health.event(event("session.usage_info", "heartbeat"));
  f.advance(1);
  assert.equal(f.health.check(false).lastEventType, "session.usage_info");
  f.advance(299_999);
  assert.equal(f.health.check(false), undefined);
  f.advance(1);
  assert.ok(f.health.check(false));
  assert.equal(f.records.filter((e) => e.operation === "progress.stalled").length, 2);
  assert.equal(f.health.event(event("assistant.message_delta", "delta", {
    deltaContent: "PRIVATE", messageId: "reply",
  })), true);
  assert.equal(f.health.snapshot().stalled, false);
  assert.equal(JSON.stringify(f.records).includes("PRIVATE"), false);
});

test("fast completion before send acknowledgment must not reopen waiting state", () => {
  const f = clock();
  f.health.sendStarted("request");
  f.health.event(event("assistant.turn_start", "start", { turnId: "0" }));
  f.health.event(event("session.idle", "idle"));
  f.health.sendSettled("request", "sdk");
  f.advance(60_000);
  assert.equal(f.health.waiting, false);
  assert.equal(f.health.check(false), undefined);
});

test("finished recovery duration remains fixed between watchdog checks", () => {
  const f = clock();
  f.health.recovery("events");
  f.advance(500);
  f.health.recovery("permissions");
  f.advance(500);
  f.health.recovery("complete");
  f.advance(60_000);
  assert.equal(f.health.snapshot().recoveryElapsedMs, 1000);
});

test("send failures and upstream errors record no raw payloads or false completion", async (t) => {
  const f = fixture(t);
  f.live.session.send = async () => { throw new Error("PRIVATE TOKEN"); };
  await assert.rejects(f.runtime.sendObserved(f.live, "request", { prompt: "PRIVATE" }), /PRIVATE TOKEN/);
  assert.equal(f.health.waiting, false);
  f.live.busy = true;
  f.runtime.handleSessionEvent(f.live, event("session.error", "error", {
    errorType: "authentication", message: "PRIVATE TOKEN", stack: "PRIVATE STACK",
    providerCallId: "provider-id", serviceRequestId: "service-id", statusCode: 401,
  }));
  assert.equal(f.live.busy, true, "errors alone do not prove the SDK or background work is idle");
  assert.equal(f.emitted.some((e) => e.type === "member.error"), true);
  const record = f.records.at(-1);
  assert.equal(record.statusCode, 401);
  assert.equal(record.providerCallId, "provider-id");
  assert.equal(JSON.stringify(f.records).includes("PRIVATE"), false);
});
