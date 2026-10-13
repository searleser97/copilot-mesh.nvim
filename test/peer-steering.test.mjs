import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentDatabase } from "../dist/database.js";
import { compactHistoryEvents } from "../dist/runtime.js";
import { peerFixture } from "./peer-steering-fixture.mjs";

function fixture(t) {
  const root = resolve(".e2e-artifacts", "peer-steering-tests");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "case-"));
  const f = peerFixture(directory);
  t.after(() => { f.cleanup(); rmSync(directory, { recursive: true, force: true }); });
  return { ...f, ...f.sessions.recipient, directory };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const busy of [false, true]) {
  test(`peer tool queues then SDK-accepts exactly once with busy=${busy}`, async (t) => {
    const f = fixture(t);
    f.live.busy = f.live.foregroundBusy = busy;
    f.live.mailboxDrainCycle = f.live.idleCycle;
    const result = f.send("Changed plan");
    assert.equal(result.status, "queued");
    assert.equal(f.row(result.messageId).status, "pending");
    await f.runtime.drainMailbox(f.live.target, false);
    await f.runtime.drainMailbox(f.live.target, false);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].mode, "immediate");
    assert.match(f.sends[0].prompt, /source="agent:peer"/);
    assert.equal(f.row(result.messageId).status, "delivered");
    assert.equal(f.db.peerTransmission(result.messageId).sdkMessageId, "recipient-1");
    assert.equal(f.live.busy, busy);
    assert.equal(f.live.foregroundBusy, busy);
    assert.equal(f.emitted.filter((entry) => entry.type === "mailbox.delivered").length, 1);
    assert.equal(f.emitted.some((entry) => entry.type === "member.foreground_idle"), false);
  });
}

test("busy peers drain FIFO across senders without an idle-cycle gate; one per wake", async (t) => {
  const f = fixture(t);
  f.live.busy = true;
  const ids = [f.send("one"), f.send("two", "other"), f.send("three")].map((item) => item.messageId);
  for (let n = 1; n <= 3; n += 1) {
    await f.runtime.drainMailbox(f.live.target, false);
    assert.equal(f.sends.length, n);
    assert.equal(f.row(ids[n - 1]).status, "delivered");
    if (n < 3) assert.equal(f.row(ids[n]).status, "pending");
  }
  assert.ok(f.runtime.mailboxDrainTimers.has(f.live.target), "continuation uses a bounded timer");
});

test("scheduled wakes drain busy backlog without idle notifications or parallel sends", async (t) => {
  const f = fixture(t);
  f.live.busy = true;
  const ids = [f.send("first"), f.send("second", "other"), f.send("third")].map((item) => item.messageId);
  const deadline = Date.now() + 5_000;
  while (f.row(ids[2]).status !== "delivered" && Date.now() < deadline) await delay(25);
  assert.deepEqual(ids.map((id) => f.row(id).status), ["delivered", "delivered", "delivered"]);
  assert.equal(f.sends.length, 3);
  assert.ok(ids.every((id, index) => f.sends[index].prompt.includes(`id="${id}"`)));
  assert.equal(f.live.busy, true);
  assert.equal(f.emitted.filter((event) => event.type === "member.foreground_idle").length, 0);
});

test("queued/retry user messages stay idle-only without blocking busy peer steering", async (t) => {
  const f = fixture(t);
  f.live.busy = true;
  f.db.enqueueMessage("user", f.live.runId, "user", f.live.target, "user", "Queued user");
  const peer = f.send("Steer now");
  await f.runtime.drainMailbox(f.live.target, true);
  assert.equal(f.row(peer.messageId).status, "delivered");
  assert.equal(f.row("user").status, "pending");
  f.live.busy = false;
  f.live.health.event({ type: "session.idle", data: {} });
  f.live.idleCycle += 1;
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(f.row("user").status, "delivered");
  assert.equal(f.sends[1].prompt, "Queued user");
});

test("foreground sends and peers never overlap and retained response correlation is not reset", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  let active = 0;
  let max = 0;
  f.live.responseCorrelation.delta("original", "turn");
  const response = f.live.responseCorrelation.snapshot();
  f.live.session.send = async (options) => {
    max = Math.max(max, ++active);
    f.sends.push(options);
    if (f.sends.length === 1) await gate.promise;
    active -= 1;
    return `send-${f.sends.length}`;
  };
  const user = f.runtime.sendUserPromptOnLive(f.live, "Foreground", true);
  const peer = f.send("peer");
  const drain = f.runtime.drainMailbox(f.live.target, false);
  const user2 = f.runtime.sendUserPromptOnLive(f.live, "Foreground2", true);
  assert.equal(f.sends.length, 1);
  gate.resolve();
  await Promise.all([user, drain, user2]);
  assert.equal(max, 1);
  assert.equal(f.sends.length, 3);
  assert.equal(f.row(peer.messageId).status, "delivered");
  assert.deepEqual(f.live.responseCorrelation.snapshot(), response);
});

test("transition before serialized send neither transmits nor claims the peer", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.live.session.send = async () => { await gate.promise; return "user-accepted"; };
  const user = f.runtime.sendUserPromptOnLive(f.live, "Foreground", true);
  const peer = f.send("peer");
  const drain = f.runtime.drainMailbox(f.live.target, false);
  f.runtime.agentGenerations.set(f.live.agentId, 2);
  gate.resolve();
  await assert.rejects(user, /no longer current/);
  await assert.rejects(drain, /no longer current/);
  assert.equal(f.row(peer.messageId).status, "pending");
  assert.equal(f.db.peerTransmission(peer.messageId), undefined);
});

test("late accepted send records receipt but cannot complete a newer lease; recovery never resends", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.live.session.send = async (options) => { f.sends.push(options); await gate.promise; return "accepted"; };
  const peer = f.send("peer");
  const drain = f.runtime.drainMailbox(f.live.target, false);
  f.db.db.prepare("UPDATE delivery_leases SET lease_until = '2000-01-01'").run();
  const newer = f.db.claimMessage(peer.messageId, f.live.runId, f.live.target);
  gate.resolve();
  await drain;
  assert.equal(f.row(peer.messageId).status, "delivering");
  assert.ok(f.emitted.some((entry) => entry.type === "mailbox.failed"));
  f.db.releaseMessage(newer.id, newer.runId, newer.target, newer.leaseToken, "test recovery");
  await f.runtime.drainMailbox(f.live.target, true);
  assert.equal(f.sends.length, 1);
  assert.equal(f.row(peer.messageId).status, "delivered");
});

test("accepted send on a superseded generation keeps its receipt and cannot complete the old lease", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.live.session.send = async (options) => { f.sends.push(options); await gate.promise; return "receipt"; };
  const id = f.send("peer").messageId;
  const drain = f.runtime.drainMailbox(f.live.target, false);
  f.runtime.agentGenerations.set("recipient", 2);
  gate.resolve();
  await drain;
  assert.equal(f.row(id).status, "pending");
  assert.equal(f.db.peerTransmission(id).sdkMessageId, "receipt");
  assert.equal(f.emitted.some((event) => event.type === "mailbox.delivered"), false);
  f.live.generation = f.live.binding.generation = 2;
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.row(id).status, "delivered");
});

test("ambiguous RPC acknowledgement fails explicitly and is never automatically replayed", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.live.session.send = async () => { attempts += 1; throw new Error("connection lost after dispatch"); };
  const peer = f.send("peer");
  await f.runtime.drainMailbox(f.live.target, false);
  await f.runtime.drainMailbox(f.live.target, true);
  assert.equal(attempts, 1);
  assert.equal(f.row(peer.messageId).status, "failed");
  const failure = f.emitted.find((entry) => entry.type === "mailbox.failed");
  assert.equal(failure.payload.retrying, false);
  assert.match(failure.payload.message, /acceptance may have occurred/);
});

test("observed SDK user message confirms acceptance despite a lost RPC reply", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.live.session.send = async ({ prompt }) => {
    attempts += 1;
    f.runtime.handleSessionEvent(f.live, {
      id: "event", type: "user.message", timestamp: new Date().toISOString(), parentId: null,
      data: { content: prompt, messageId: "accepted", delivery: "steering" },
    });
    throw new Error("reply lost");
  };
  const peer = f.send("peer");
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(attempts, 1);
  assert.equal(f.row(peer.messageId).status, "delivered");
  assert.equal(f.emitted.find((entry) => entry.type === "agent.prompt").payload.sourceAgentId, "peer");
  assert.equal(f.emitted.find((entry) => entry.type === "agent.prompt").payload.delivery, "steering");
  assert.match(f.emitted.find((entry) => entry.type === "mailbox.warning").payload.message, /reply lost/);
});

test("failed lease completion retries reconciliation with the receipt, never the SDK call", async (t) => {
  const f = fixture(t);
  const complete = f.db.completeMessage.bind(f.db);
  f.db.completeMessage = () => { throw new Error("temporary completion failure"); };
  const id = f.send("peer").messageId;
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(f.row(id).status, "pending");
  assert.equal(f.db.peerTransmission(id).sdkMessageId, "recipient-1");
  f.db.completeMessage = complete;
  await f.runtime.drainMailbox(f.live.target, true);
  assert.equal(f.row(id).status, "delivered");
  assert.equal(f.sends.length, 1);
});

test("journal survives a restart/adoption and unconfirmed intents do not transmit", async (t) => {
  const f = fixture(t);
  const ids = [f.send("accepted"), f.send("unknown")].map((item) => item.messageId);
  for (const id of ids) {
    const message = f.db.claimMessage(id, f.live.runId, f.live.target);
    f.db.beginPeerTransmission(message, f.live.session.sessionId);
    if (id === ids[0]) f.db.acceptPeerTransmission(id, f.live.session.sessionId, "receipt");
    f.db.releaseMessage(id, message.runId, message.target, message.leaseToken, "recovery");
  }
  f.db.createAgentRun("successor", "recipient", "successor", "{}", f.directory, process.pid);
  f.db.finishRun(f.live.runId, "interrupted", "restart");
  f.db.adoptAgentMessages("successor", f.directory, "recipient", f.live.target);
  f.live.runId = f.context.runId = f.live.binding.runId = "successor";
  await f.runtime.drainMailbox(f.live.target, false);
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(f.sends.length, 0);
  assert.equal(f.row(ids[0]).status, "delivered");
  assert.equal(f.row(ids[1]).status, "failed");
});

test("ACL revocation/session identity guesses do not enqueue and delivery never changes permissions", async (t) => {
  const f = fixture(t);
  const source = f.sessions.peer.context;
  source.canTalkTo.clear();
  assert.throws(() => f.send("not authorized"), /not allowed/);
  const tool = f.runtime.createAgentMessagingTools(source).find((entry) => entry.name === "real_agent_send_message");
  assert.throws(() => tool.handler({ recipient: f.live.session.sessionId, message: "guess" }), /not allowed/);
  assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  const permission = f.context.agent.permission;
  source.canTalkTo.add("recipient");
  f.send("authorized");
  await f.runtime.drainMailbox(f.live.target, false);
  assert.deepEqual(f.context.agent.permission, permission);
});

test("failure before transmission retries with bounded backoff without skipping FIFO", async (t) => {
  const f = fixture(t);
  const ids = [f.send("first"), f.send("second")].map((entry) => entry.messageId);
  const begin = f.db.beginPeerTransmission.bind(f.db);
  f.db.beginPeerTransmission = () => { throw new Error("durable intent write failed"); };
  await f.runtime.drainMailbox(f.live.target, false);
  assert.equal(f.row(ids[0]).status, "pending");
  assert.equal(f.sends.length, 0);
  assert.ok(f.runtime.mailboxRetryTimers.has(f.live.target));
  f.db.beginPeerTransmission = begin;
  await f.runtime.drainMailbox(f.live.target, true);
  assert.match(f.sends[0].prompt, /first/);
  assert.equal(f.row(ids[1]).status, "pending");
});

test("SDK receipts survive closing the database and cannot be replaced by another session or message", (t) => {
  const f = fixture(t);
  const id = f.send("persistent").messageId;
  const message = f.db.claimMessage(id, f.live.runId, f.live.target);
  f.db.beginPeerTransmission(message, f.live.session.sessionId);
  assert.throws(() => f.db.acceptPeerTransmission(id, "wrong-session", "accepted"), /could not persist/);
  f.db.acceptPeerTransmission(id, f.live.session.sessionId, "accepted");
  assert.throws(() => f.db.acceptPeerTransmission(id, f.live.session.sessionId, "different"), /could not persist/);
  f.cleanup();
  const reopened = new AgentDatabase(join(f.directory, "state.sqlite"), () => false);
  assert.deepEqual({ ...reopened.peerTransmission(id) }, {
    sessionId: f.live.session.sessionId, sdkMessageId: "accepted",
  });
  reopened.close();
});

test("history preserves the durable sender and actual steering delivery without inventing it", () => {
  const events = compactHistoryEvents([{
    id: "injected", type: "user.message", timestamp: new Date().toISOString(),
    data: {
      content: '<agent_message id="mail" source="agent:peer">\nUpdate\n</agent_message>\n\nProcess this durable message from another Copilot agent.',
      delivery: "steering",
    },
  }]);
  assert.equal(events[0].data.sourceAlias, "agent:peer");
  assert.equal(events[0].data.agentMessageId, "mail");
  assert.equal(events[0].data.delivery, "steering");
});
