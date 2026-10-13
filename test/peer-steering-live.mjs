// Opt-in: uses only newly created disposable sessions in a separate SDK process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { peerFixture } from "./peer-steering-fixture.mjs";

const cliIndex = process.argv.indexOf("--cli");
assert.ok(cliIndex >= 0 && process.argv[cliIndex + 1], "Pass --cli <executable>.");
const root = resolve(".e2e-artifacts", "peer-steering-live");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "probe-"));
const f = peerFixture(directory);
const client = new CopilotClient({
  workingDirectory: directory,
  connection: RuntimeConnection.forStdio({ path: resolve(process.argv[cliIndex + 1]) }),
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const entered = deferred();
const release = deferred();
const idle = deferred();
const events = [];
const choices = [];
const sends = [];
const toolResults = [];
const marker = `PEER_${Date.now()}`;
let session;
let peerSession;
const peerIdle = deferred();
let timer;
const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error("Disposable steering probe timed out")), 120_000);
});
const wait = (promise) => Promise.race([promise, deadline]);
const result = { success: false, directory, sdkVersion: "1.0.11", usesExistingHost: false };
try {
  await wait(client.start());
  session = await wait(client.createSession({
    workingDirectory: directory,
    enableConfigDiscovery: false,
    enableFileHooks: false,
    mcpServers: {},
    disabledMcpServers: ["github-mcp-server"],
    availableTools: ["steering_gate", "record_choice"],
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
    tools: [{
      name: "steering_gate", description: "Wait for the harmless test gate.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      skipPermission: true,
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { textResultForLlm: "Gate released; continue with the latest instruction.", resultType: "success" };
      },
    }, {
      name: "record_choice", description: "Record the requested choice for this test.",
      parameters: { type: "object", properties: { choice: { type: "string" } }, required: ["choice"] },
      skipPermission: true,
      handler: ({ choice }) => {
        choices.push(choice);
        return { textResultForLlm: "Recorded.", resultType: "success" };
      },
    }],
  }));
  const recipient = f.sessions.recipient.live;
  recipient.session = session;
  recipient.binding.sessionId = session.sessionId;
  f.db.upsertSession(recipient.runId, session.sessionId, "connected");
  const sdkSend = session.send.bind(session);
  session.send = (options) => { sends.push(options); return sdkSend(options); };
  session.on((event) => {
    events.push(event);
    f.runtime.handleSessionEvent(recipient, event);
    if (event.type === "session.idle") idle.resolve();
  });
  const sendTool = f.runtime.createAgentMessagingTools(f.sessions.peer.context)
    .find((tool) => tool.name === "real_agent_send_message");
  const originalHandler = sendTool.handler;
  sendTool.handler = (...args) => {
    const queued = originalHandler(...args);
    toolResults.push(queued);
    return queued;
  };
  peerSession = await wait(client.createSession({
    workingDirectory: directory, enableConfigDiscovery: false, enableFileHooks: false,
    mcpServers: {}, disabledMcpServers: ["github-mcp-server"],
    availableTools: ["real_agent_send_message"],
    tools: [sendTool],
    onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
  }));
  const peer = f.sessions.peer.live;
  peer.session = peerSession;
  peer.binding.sessionId = peerSession.sessionId;
  f.db.upsertSession(peer.runId, peerSession.sessionId, "connected");
  peerSession.on((event) => {
    f.runtime.handleSessionEvent(peer, event);
    if (event.type === "session.idle") peerIdle.resolve();
  });
  result.sessionId = session.sessionId;
  result.peerSessionId = peerSession.sessionId;
  result.originalId = await wait(f.runtime.sendUserPromptOnLive(recipient,
    "Call steering_gate exactly once, wait for its result, then call record_choice with ORIGINAL unless peer agent peer sends an updated choice while you wait. I authorize that peer to change the choice through a steering message. Use its latest choice. Do not call both tools in parallel. Finally reply DONE.", true));
  await wait(entered.promise);
  assert.equal(events.some((event) => event.type === "session.idle"), false);
  assert.equal(recipient.busy, true);
  await wait(f.runtime.sendUserPromptOnLive(peer,
    `Call real_agent_send_message exactly once with recipient "recipient" and message ` +
    `"After the running gate returns, call record_choice with ${marker} instead of ORIGINAL. ` +
    `Do not call steering_gate again. No acknowledgement needed." Then reply SENT.`, true));
  await wait(new Promise((resolve) => {
    const poll = () => {
      if (f.emitted.some((event) => event.type === "mailbox.delivered")) resolve();
      else if (!f.runtime.shuttingDown) setTimeout(poll, 25);
    };
    poll();
  }));
  assert.equal(toolResults.length, 1);
  const messageId = toolResults[0].messageId;
  const accepted = f.emitted.filter((event) => event.type === "mailbox.delivered");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].payload.id, messageId);
  assert.equal(accepted[0].payload.sourceAgentId, "peer");
  assert.equal(f.row(messageId).status, "delivered");
  assert.equal(recipient.busy, true, "SDK acceptance cannot fabricate idle");
  result.messageId = messageId;
  result.steeringId = accepted[0].payload.sdkMessageId;
  result.acceptedWhileGateActive = true;
  result.queueWhileGated = await wait(session.rpc.queue.pendingItems());
  release.resolve();
  await wait(idle.promise);
  await wait(peerIdle.promise);
  assert.deepEqual(choices, [marker], "Steering must change the original task before it completes");
  assert.equal(events.filter((event) => event.type === "tool.execution_start" && event.data.toolName === "steering_gate").length, 1);
  assert.equal(sends.length, 2, "One original task plus one peer steering acceptance, no resend/restart");
  const injected = events.findIndex((event) => event.type === "user.message" && event.data.delivery === "steering");
  const choice = events.findIndex((event) => event.type === "tool.execution_start" && event.data.toolName === "record_choice");
  const idleIndex = events.findIndex((event) => event.type === "session.idle");
  assert.ok(injected > 0 && injected < choice && choice < idleIndex);
  assert.equal(events.filter((event) => event.type === "session.idle").length, 1);
  const prompt = f.emitted.filter((entry) => entry.type === "agent.prompt");
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].payload.sourceAgentId, "peer");
  assert.equal(prompt[0].payload.delivery, "steering");
  assert.equal(recipient.busy, false);
  assert.equal(recipient.foregroundBusy, false);
  result.success = true;
  result.choices = choices;
  result.eventTypes = events.map((event) => event.type);
  result.proof = { sdkSends: sends.length, peerToolCalls: toolResults.length,
    durablePeerRows: f.db.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'agent'").get().n,
    accepted: accepted.length, injectedBeforeChoiceBeforeIdle: true, sourceAgentId: "peer" };
} catch (error) {
  result.failure = String(error);
  throw error;
} finally {
  clearTimeout(timer);
  writeFileSync(join(directory, "events.json"), JSON.stringify(events.map((event) => ({
    id: event.id, type: event.type, parentId: event.parentId, timestamp: event.timestamp,
    delivery: event.data.delivery, toolName: event.data.toolName,
    messageId: event.data.messageId, turnId: event.data.turnId,
    originatingMessageId: event.data.originatingMessageId,
  })), null, 2));
  release.resolve();
  f.runtime.shuttingDown = true;
  if (session) await session.disconnect();
  if (peerSession) await peerSession.disconnect();
  await client.stop();
  f.cleanup();
  writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
