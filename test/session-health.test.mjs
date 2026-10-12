import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";
import { AssistantResponseCorrelation, CopilotRuntime } from "../dist/runtime.js";
import { SessionHealth } from "../dist/session-health.js";
import { SessionEventOrder } from "../dist/session-event-order.js";

let previousEventId = null;
function event(type, id, data = {}) {
  const parentId = previousEventId;
  previousEventId = id;
  return { type, id, data, timestamp: "2026-10-12T19:49:12.072Z", parentId };
}

function clock() {
  let now = Date.now();
  const records = [];
  const health = new SessionHealth((entry) => records.push(entry), () => now);
  return { health, records, advance: (ms) => { now += ms; } };
}

function fixture(t) {
  previousEventId = null;
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
    eventOrder: new SessionEventOrder(), recoveryOrderingWarning: false, recoveryOrderingRevision: -1,
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

for (const terminal of ["session.idle", "assistant.turn_end", "session.error"]) {
  test(`recovered older ${terminal} cannot affect a newer turn on the same connection`, async (t) => {
    const f = fixture(t);
    const oldStart = event("assistant.turn_start", "old-start", { turnId: "0" });
    const oldTerminal = {
      ...event(terminal, "old-terminal", {
        turnId: "0", errorType: "query", message: "Older turn error",
      }),
      parentId: oldStart.id,
    };
    const newStart = {
      ...event("assistant.turn_start", "new-start", { turnId: "0" }),
      parentId: oldTerminal.id,
    };
    f.runtime.handleSessionEvent(f.live, oldStart);
    let finish;
    f.live.session.rpc.eventLog.read = () => new Promise((resolve) => { finish = resolve; });
    const pending = f.runtime.recoverSilentSession(f.live);
    f.runtime.handleSessionEvent(f.live, newStart);
    const beforeRecovery = f.emitted.length;
    finish({
      events: [oldTerminal], cursor: "old-terminal-cursor",
      hasMore: false, cursorStatus: "ok",
    });
    await pending;
    assert.equal(f.live.foregroundBusy, true);
    assert.equal(f.live.foregroundTurnId, "0");
    assert.equal(f.live.foregroundTurnSequence, 2);
    assert.equal(f.emitted.slice(beforeRecovery).some((entry) =>
      entry.type === "member.error" ||
      entry.type === "member.foreground_idle" ||
      entry.type === "member.turn_end" ||
      entry.type === "member.state"
    ), false, "older terminal must remain visible without changing current UI state");
    assert.equal(f.emitted.filter((entry) =>
      entry.type === "recovery.historical_event" && entry.payload.eventId === oldTerminal.id
    ).length, 1);
  });
}

for (const completed of [false, true]) {
  test(`late older output and side effects stay historical when newer turn completed=${completed}`, async (t) => {
    const f = fixture(t);
    const start = event("assistant.turn_start", "old-start", { turnId: "0" });
    const earlier = [
      event("tool.execution_start", "tool-start", { toolCallId: "old-tool", toolName: "powershell" }),
      event("tool.execution_complete", "tool-end", { toolCallId: "old-tool", success: true, result: { content: "old result" } }),
      event("assistant.message_delta", "old-delta", { messageId: "old-reply", deltaContent: "Old " }),
      event("assistant.message", "old-message", { messageId: "old-reply", turnId: "0", content: "Old response" }),
      event("assistant.turn_end", "old-end", { turnId: "0" }),
      event("session.error", "old-error", { errorType: "query", message: "Old error" }),
      event("session.idle", "old-idle"),
    ];
    const current = event("assistant.turn_start", "current-start", { turnId: "0" });
    f.runtime.handleSessionEvent(f.live, start);
    f.runtime.handleSessionEvent(f.live, current);
    f.runtime.handleSessionEvent(f.live, event("assistant.message_delta", "current-delta", {
      messageId: "current-reply", deltaContent: "Current",
    }));
    if (completed) {
      f.runtime.handleSessionEvent(f.live, event("assistant.message", "current-message", {
        messageId: "current-reply", turnId: "0", content: "Current",
      }));
      f.runtime.handleSessionEvent(f.live, event("assistant.turn_end", "current-end", { turnId: "0" }));
      f.runtime.handleSessionEvent(f.live, event("session.idle", "current-idle"));
    }
    const snapshot = {
      busy: f.live.busy, foregroundBusy: f.live.foregroundBusy,
      turn: f.live.foregroundTurnId, idleCycle: f.live.idleCycle,
      correlation: f.live.responseCorrelation.snapshot(),
    };
    const before = f.emitted.length;
    let drains = 0;
    f.runtime.scheduleMailboxDrain = () => { drains += 1; };
    f.live.session.rpc.eventLog.read = async () => ({
      events: earlier, cursor: "old-tail", hasMore: false, cursorStatus: "expired",
    });
    await f.runtime.recoverSilentSession(f.live);
    await f.runtime.recoverSilentSession(f.live);
    assert.deepEqual({
      busy: f.live.busy, foregroundBusy: f.live.foregroundBusy,
      turn: f.live.foregroundTurnId, idleCycle: f.live.idleCycle,
      correlation: f.live.responseCorrelation.snapshot(),
    }, snapshot);
    assert.equal(drains, 0);
    assert.equal(f.emitted.slice(before).length, earlier.length);
    assert.ok(f.emitted.slice(before).every((entry) => entry.type === "recovery.historical_event"));
    assert.equal(f.sends(), 0);
  });
}

test("lookahead uses page order across ancestry gaps while streamed turns continue", async (t) => {
  const f = fixture(t);
  const oldIdle = { ...event("session.idle", "old-idle"), parentId: "lost-old-parent" };
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "lost-current-parent" };
  f.runtime.handleSessionEvent(f.live, current);
  let reads = 0;
  let finish;
  f.live.session.rpc.eventLog.read = async () => {
    reads += 1;
    if (reads === 1) return { events: [oldIdle], cursor: "page-1", hasMore: true, cursorStatus: "expired" };
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = f.runtime.recoverSilentSession(f.live);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.live.recoveryCursor, "initial-tail", "unclassified prefix must not commit");
  assert.equal(f.live.eventOrder.pending, 1);
  const newer = { ...event("assistant.turn_start", "newer", { turnId: "0" }), parentId: current.id };
  f.runtime.handleSessionEvent(f.live, newer);
  finish({ events: [current, newer], cursor: "page-2", hasMore: false, cursorStatus: "ok" });
  await pending;
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.live.foregroundTurnSequence, 2);
  assert.equal(f.live.eventOrder.watermark, newer.id);
  assert.equal(f.live.eventOrder.pending, 0);
  assert.equal(f.live.recoveryCursor, "page-2");
  assert.equal(f.emitted.filter((e) => e.type === "recovery.historical_event").length, 1);
});

test("unorderable expiry is bounded, visible, blocks permission guesses and preserves streaming", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "lost-current-parent" };
  f.runtime.handleSessionEvent(f.live, current);
  let reads = 0;
  let last;
  f.live.session.rpc.eventLog.read = async ({ max }) => {
    assert.equal(max, 200);
    const events = Array.from({ length: 200 }, (_, index) => {
      const id = `old-${reads}-${index}`;
      const item = { ...event("session.idle", id), parentId: last?.id ?? "lost-old-parent" };
      last = item;
      return item;
    });
    reads += 1;
    return { events, cursor: `page-${reads}`, hasMore: true, cursorStatus: reads === 1 ? "expired" : "ok" };
  };
  f.live.session.rpc.permissions.pendingRequests = () => assert.fail("unreconciled history must not deny permissions");
  await f.runtime.recoverSilentSession(f.live);
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 5);
  assert.equal(f.live.eventOrder.pending, 1000);
  assert.equal(f.live.recoveryCursor, "initial-tail");
  assert.equal(f.health.snapshot().recoveryPhase, "ordering_blocked");
  assert.equal(f.emitted.filter((e) => e.type === "member.recovery_warning").length, 1);
  const delta = { ...event("assistant.message_delta", "current-delta", { messageId: "reply", deltaContent: "Still live" }), parentId: current.id };
  f.runtime.handleSessionEvent(f.live, delta);
  assert.equal(f.emitted.at(-1).type, "conversation.delta");
  assert.equal(f.live.foregroundBusy, true);
  const anchor = { ...event("assistant.turn_start", "anchor", { turnId: "1" }), parentId: last.id };
  f.runtime.handleSessionEvent(f.live, anchor);
  f.live.session.rpc.eventLog.read = async ({ cursor }) => {
    assert.equal(cursor, "page-5");
    return { events: [], cursor, hasMore: false, cursorStatus: "ok" };
  };
  f.live.session.rpc.permissions.pendingRequests = async () => ({ items: [] });
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.live.eventOrder.pending, 0);
  assert.equal(f.live.recoveryCursor, "page-5");
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.emitted.filter((e) => e.type === "recovery.historical_event").length, 1000);
  assert.equal(f.emitted.filter((e) => e.type === "member.recovery_resumed").length, 1);
});

test("startup history cannot overwrite a newer stream and genuine current terminals still apply", async (t) => {
  const f = fixture(t);
  const older = [
    event("assistant.turn_start", "old-start", { turnId: "0" }),
    event("assistant.turn_end", "old-end", { turnId: "0" }),
  ];
  const current = event("assistant.turn_start", "current", { turnId: "0" });
  f.runtime.handleSessionEvent(f.live, current);
  f.live.eventOrder.recordHistory([...older, current]);
  f.runtime.applyOrderedHistoryState(f.live, older);
  assert.equal(f.live.eventOrder.watermark, current.id);
  assert.equal(f.live.foregroundBusy, true);
  const events = [
    event("assistant.message", "reply", { messageId: "reply", turnId: "0", content: "Current response" }),
    event("assistant.turn_end", "end", { turnId: "0" }),
    event("session.idle", "idle"),
  ];
  f.live.session.rpc.eventLog.read = async () => ({
    events, cursor: "new-tail", hasMore: false, cursorStatus: "ok",
  });
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.live.foregroundBusy, false);
  assert.equal(f.emitted.filter((e) => e.type === "conversation.message").length, 1);
  assert.equal(f.emitted.filter((e) => e.type === "member.foreground_idle").length, 1);
});

for (const source of ["startup", "recovery"]) {
  test(`older ${source} usage counts exactly once without reverting the current model`, async (t) => {
    const f = fixture(t);
    const usage = event("assistant.usage", "old-usage", {
      model: "old-model", copilotUsage: { totalNanoAiu: 2_000_000_000 },
    });
    const current = event("assistant.turn_start", "current", { turnId: "0" });
    f.runtime.handleSessionEvent(f.live, current);
    f.live.aicUsed = 1;
    f.live.modelId = "current-model";
    if (source === "startup") {
      f.live.eventOrder.recordHistory([usage, current]);
      f.runtime.applyOrderedHistoryState(f.live, [usage]);
      f.live.seenEventIds.add(usage.id);
    }
    f.live.session.rpc.eventLog.read = async () => ({
      events: [usage], cursor: "usage-tail", hasMore: false, cursorStatus: "expired",
    });
    await f.runtime.recoverSilentSession(f.live);
    await f.runtime.recoverSilentSession(f.live);
    assert.equal(f.live.aicUsed, 3);
    assert.equal(f.live.modelId, "current-model");
    assert.equal(f.live.foregroundBusy, true);
  });
}

test("historical permissions retain originals without repeating completed tool or permission effects", async (t) => {
  const f = fixture(t);
  const request = { kind: "read", path: "E:\\allowed\\file.txt" };
  const requested = event("permission.requested", "permission-event", {
    requestId: "permission", permissionRequest: request,
  });
  const current = event("assistant.turn_start", "current", { turnId: "0" });
  f.runtime.handleSessionEvent(f.live, current);
  const answers = [];
  f.runtime.agents.set("agent", { agent: { permission: {} } });
  f.runtime.evaluatePermissionRequest = async (_policy, _binding, actual) => {
    assert.deepEqual(actual, request);
    return { kind: "respond", response: { kind: "approved" } };
  };
  f.live.session.rpc.permissions.pendingRequests = async () => ({
    items: answers.length ? [] : [{ requestId: "permission" }],
  });
  f.live.session.rpc.permissions.handlePendingPermissionRequest = async (answer) => { answers.push(answer); };
  f.live.session.rpc.eventLog.read = async () => ({
    events: [requested], cursor: "request-tail", hasMore: false, cursorStatus: "expired",
  });
  await f.runtime.recoverSilentSession(f.live);
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(answers.length, 1);
  assert.equal(f.emitted.filter((e) => e.type === "permission.requested").length, 0);
  assert.equal(f.emitted.filter((e) => e.type === "recovery.historical_event").length, 1);
  assert.equal(f.live.foregroundBusy, true);
});

test("connection continuity copies quarantined records and ordering metadata without aliasing", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "lost-current" };
  f.runtime.handleSessionEvent(f.live, current);
  const old = { ...event("session.idle", "old-idle"), parentId: "lost-old" };
  f.live.eventOrder.enqueue([old], "scan-cursor", true);
  const continuity = f.runtime.captureContinuity(f.live);
  assert.equal(continuity.recoveryCursor, "initial-tail");
  assert.equal(continuity.eventOrder.pending, 1);
  f.live.eventOrder.watermark = old.id;
  f.live.eventOrder.drain(new Set([old.id]), () => assert.fail("seen"), () => {});
  assert.equal(continuity.eventOrder.watermark, current.id);
  assert.equal(continuity.eventOrder.pending, 1);
  assert.equal(continuity.eventOrder.readCursor("initial-tail"), "scan-cursor");
});

test("idle watchdog drains retained events after a streamed completion supplies ordering", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "lost-current" };
  f.runtime.handleSessionEvent(f.live, current);
  const old = { ...event("session.error", "old-error", { errorType: "query", message: "Earlier error" }), parentId: "lost-old" };
  f.live.session.rpc.eventLog.read = async () => ({
    events: [old], cursor: "scan", hasMore: false, cursorStatus: "expired",
  });
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.live.eventOrder.pending, 1);
  const idle = { ...event("session.idle", "idle"), parentId: old.id };
  f.runtime.handleSessionEvent(f.live, idle);
  assert.equal(f.live.busy, false);
  f.live.session.rpc.eventLog.read = async ({ cursor }) => ({
    events: [], cursor, hasMore: false, cursorStatus: "ok",
  });
  f.advance(10_000);
  await f.runtime.recoverSilentSessions();
  assert.equal(f.live.eventOrder.pending, 0);
  assert.equal(f.live.recoveryOrderingWarning, false);
  assert.equal(f.emitted.filter((e) => e.type === "member.error").length, 0);
  assert.equal(f.emitted.filter((e) => e.type === "recovery.historical_event").length, 1);
});

test("empty reads behind an unresolved prefix retain only one empty checkpoint", () => {
  const order = new SessionEventOrder();
  order.watermark = "unknown-watermark";
  const pending = { ...event("session.idle", "pending-idle"), parentId: "unknown-parent" };
  order.enqueue([pending], "pending", true);
  for (let index = 0; index < 1000; index += 1) {
    order.enqueue([], `empty-${index}`, false);
  }
  const committed = [];
  order.drain(new Set([pending.id]), () => assert.fail("seen"), (cursor) => committed.push(cursor));
  assert.deepEqual(committed, ["pending", "empty-999"]);
  assert.equal(order.pending, 0);
});

test("an unresolved gap waits for new evidence rather than repolling the same cursor", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "missing-current" };
  const old = { ...event("session.idle", "old"), parentId: "missing-old" };
  f.runtime.handleSessionEvent(f.live, current);
  let reads = 0;
  f.live.session.rpc.eventLog.read = async () => {
    reads += 1;
    return { events: [old], cursor: "gap-tail", hasMore: false, cursorStatus: "expired" };
  };
  f.live.session.rpc.permissions.pendingRequests = () => assert.fail("unknown permission ordering");
  await f.runtime.recoverSilentSession(f.live);
  for (let index = 0; index < 100; index += 1) await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 1);
  assert.equal(f.live.eventOrder.pending, 1);
  assert.equal(f.live.recoveryCursor, "initial-tail");
  assert.match(f.emitted.at(-1).payload.message, /Recovery degraded: ordering unknown/);
  assert.equal(f.live.seenEventIds.has(old.id), false);
  const anchor = { ...event("assistant.turn_start", "anchor", { turnId: "1" }), parentId: old.id };
  f.runtime.handleSessionEvent(f.live, anchor);
  f.live.session.rpc.permissions.pendingRequests = async () => ({ items: [] });
  f.live.session.rpc.eventLog.read = async ({ cursor }) => {
    assert.equal(cursor, "gap-tail");
    reads += 1;
    return { events: [], cursor, hasMore: false, cursorStatus: "ok" };
  };
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 2);
  assert.equal(f.live.eventOrder.pending, 0);
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.emitted.filter((entry) => entry.type === "recovery.historical_event").length, 1);
});

test("oversized unresolved payload preserves its checkpoint without retention or permission effects", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "missing-current" };
  f.runtime.handleSessionEvent(f.live, current);
  const old = { ...event("assistant.message", "oversized", {
    messageId: "old-reply", content: "x".repeat(8 * 1024 * 1024),
  }), parentId: "missing-old" };
  let reads = 0;
  f.live.session.rpc.eventLog.read = async ({ cursor }) => {
    reads += 1;
    assert.equal(cursor, "initial-tail");
    return { events: [old], cursor: "oversized-tail", hasMore: false, cursorStatus: "expired" };
  };
  f.live.session.rpc.permissions.pendingRequests = () => assert.fail("unapplied permission history");
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(f.live.eventOrder.pendingBytes, 0);
  assert.equal(f.live.eventOrder.pending, 1, "keep the unapplied identity even without its payload");
  assert.equal(f.live.recoveryCursor, "initial-tail");
  assert.equal(f.live.seenEventIds.has(old.id), false);
  assert.match(f.emitted.at(-1).payload.message, /payload budget was exceeded/);
  for (let index = 0; index < 10; index += 1) await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 1);
  assert.equal(f.emitted.filter((entry) => entry.type === "member.recovery_warning").length, 1);
  const anchor = { ...event("assistant.turn_start", "anchor", { turnId: "1" }), parentId: old.id };
  f.runtime.handleSessionEvent(f.live, anchor);
  f.live.session.rpc.permissions.pendingRequests = async () => ({ items: [] });
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 2);
  assert.equal(f.live.recoveryCursor, "oversized-tail");
  assert.equal(f.live.recoveryOrderingWarning, false);
  assert.equal(f.live.foregroundBusy, true);
  assert.equal(f.emitted.filter((entry) => entry.type === "recovery.historical_event").length, 1);
});

test("pruned oversized records cannot silently close a known recovery gap", async (t) => {
  const f = fixture(t);
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "missing-current" };
  f.runtime.handleSessionEvent(f.live, current);
  const missing = { ...event("assistant.message", "missing-payload", {
    messageId: "old", content: "x".repeat(8 * 1024 * 1024),
  }), parentId: "missing-old" };
  f.live.session.rpc.eventLog.read = async () => ({
    events: [missing], cursor: "old-tail", hasMore: false, cursorStatus: "ok",
  });
  f.live.session.rpc.permissions.pendingRequests = () => assert.fail("recovery gap still unresolved");
  await f.runtime.recoverSilentSession(f.live);
  const anchor = { ...event("assistant.turn_start", "anchor", { turnId: "1" }), parentId: missing.id };
  f.runtime.handleSessionEvent(f.live, anchor);
  let reads = 0;
  f.live.session.rpc.eventLog.read = async () => {
    reads += 1;
    return { events: [], cursor: "rebased-tail", hasMore: false, cursorStatus: "expired" };
  };
  await f.runtime.recoverSilentSession(f.live);
  await f.runtime.recoverSilentSession(f.live);
  assert.equal(reads, 1);
  assert.equal(f.live.eventOrder.pending, 1);
  assert.equal(f.live.eventOrder.pendingBytes, 0);
  assert.equal(f.live.recoveryCursor, "initial-tail");
  assert.equal(f.live.recoveryOrderingWarning, true);
  assert.equal(f.live.seenEventIds.has(missing.id), false);
  assert.equal(f.emitted.some((entry) => entry.type === "member.recovery_resumed"), false);
  assert.equal(f.live.eventOrder.copy().pending, 1, "reconnect must retain the missing identity");
});

test("ordering metadata stays bounded without fabricating order after eviction", () => {
  const order = new SessionEventOrder();
  const current = { ...event("assistant.turn_start", "current", { turnId: "0" }), parentId: "missing-current" };
  order.record(current);
  order.advance(current);
  for (let index = 0; index < 25_000; index += 1) {
    order.record({ ...event("session.idle", `bounded-${index}`), parentId: `missing-${index}` });
  }
  assert.equal(order.nodes.size, 20_000);
  assert.ok(order.nodes.has(current.id));
  assert.equal(order.relation("bounded-0"), "unknown");
  assert.equal(order.relation("bounded-24999"), "unknown");
  assert.ok([...order.nodes.values()].every((node) => node.parents.length <= 3));
});

test("large ordered startup snapshots preserve state despite bounded metadata eviction", (t) => {
  const f = fixture(t);
  const history = [
    event("assistant.turn_start", "old-start", { turnId: "0" }),
    ...Array.from({ length: 21_000 }, (_, index) => event("assistant.message", `history-${index}`, {
      messageId: `message-${index}`, content: "Earlier content",
    })),
    event("assistant.turn_end", "old-end", { turnId: "0" }),
    event("session.shutdown", "shutdown"),
  ];
  f.runtime.applyOrderedHistoryState(f.live, history);
  assert.equal(f.live.busy, false);
  assert.equal(f.live.foregroundBusy, false);
  assert.equal(f.live.eventOrder.watermark, "shutdown");
  assert.equal(f.live.recoveryOrderingWarning, false);
  assert.equal(f.live.eventOrder.nodes.size, 20_000);
  const current = event("assistant.turn_start", "current", { turnId: "0" });
  f.runtime.handleSessionEvent(f.live, current);
  f.runtime.applyOrderedHistoryState(f.live, [...history, current]);
  assert.equal(f.live.foregroundBusy, true, "an already-streamed startup turn must survive old state");
  assert.equal(f.live.eventOrder.watermark, current.id);
  assert.equal(f.live.recoveryOrderingWarning, false);
  assert.equal(f.live.eventOrder.nodes.size, 20_000);
});

for (const stage of ["tail", "history"]) {
  test(`startup streaming during delayed ${stage} preserves the new turn and history inputs`, async (t) => {
    const f = fixture(t);
    const older = [
      event("assistant.turn_start", "old-start", { turnId: "0" }),
      event("permission.requested", "permission", {
        requestId: "permission", permissionRequest: { kind: "read", path: "E:\\allowed.txt" },
      }),
      event("assistant.turn_end", "old-end", { turnId: "0" }),
      event("session.shutdown", "old-shutdown"),
    ];
    const current = event("assistant.turn_start", "current", { turnId: "0" });
    let subscribed;
    let unblock;
    let entered;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const reached = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    const session = {
      sessionId: "startup-session",
      on: (listener) => { subscribed = listener; calls.push("subscribe"); return () => {}; },
      getEvents: async () => {
        calls.push("history");
        if (stage === "history") { entered(); await blocked; }
        return older;
      },
      rpc: {
        permissions: { setApproveAll: async () => {} },
        eventLog: { tail: async () => {
          calls.push("tail");
          if (stage === "tail") { entered(); await blocked; }
          return { cursor: "startup-tail" };
        } },
        tools: { initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [] }) },
        instructions: { getSources: async () => ({ sources: [] }) },
        skills: { list: async () => ({ skills: [] }) },
        mcp: { list: async () => ({ servers: [] }) },
        plugins: { list: async () => ({ plugins: [] }) },
        agent: { list: async () => ({ agents: [] }) },
      },
    };
    f.runtime.ensureClient = async () => ({ createSession: async () => session });
    f.runtime.assertConnectionCurrent = () => ({ agent: { permission: {} } });
    f.runtime.activateSessionBinding = () => ({});
    f.runtime.bindSessionHandlers = (config) => config;
    f.runtime.sessionBindingCurrent = () => true;
    f.runtime.assertLiveMatchesRequest = () => {};
    f.runtime.modelStateForLive = async () => {};
    const historyInputs = [];
    f.runtime.replayHistory = async (_run, _target, events) => { historyInputs.push(...events); };
    const pending = f.runtime.establishSession({
      runId: "run", target: f.live.target, agentId: "agent", alias: "worker",
      config: {}, configSignature: "startup-test", availableMcpServers: new Set(),
    }, { generation: 1 });
    await reached;
    subscribed(current);
    unblock();
    const live = await pending;
    assert.deepEqual(calls, ["subscribe", "tail", "history"]);
    assert.equal(live.recoveryCursor, "startup-tail");
    assert.equal(live.foregroundBusy, true);
    assert.equal(live.eventOrder.watermark, current.id);
    assert.equal(live.recoveryPermissionRequests.get("permission").path, "E:\\allowed.txt");
    assert.ok(historyInputs.length > 0);
    assert.equal(f.emitted.filter((entry) => entry.type === "member.state").at(-1).payload.state, "busy");
  });
}

test("partial ancestry, history anchors and expired overlaps never invert established order", () => {
  let seed = 7381;
  const choose = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % 3;
  };
  for (let run = 0; run < 20; run += 1) {
    const order = new SessionEventOrder();
    const events = Array.from({ length: 100 }, (_, index) => ({
      ...event("session.idle", `event-${index}`),
      parentId: index === 0 ? null : `event-${index - 1}`,
    }));
    const available = events.filter(() => choose() !== 0);
    for (const item of available) order.record(item);
    order.recordHistory(events.filter((_, index) => index % 4 === 0));
    order.enqueue(events.slice(20, 40), "page-1", false);
    order.enqueue(events.slice(40, 60), "page-2", false);
    order.enqueue(events.slice(30, 80).filter(() => choose() !== 0), "expired-page", true);
    order.watermark = events[50].id;
    for (let index = 0; index < events.length; index += 1) {
      const relation = order.relation(events[index].id);
      if (relation !== "unknown") {
        assert.equal(relation, index < 50 ? "before" : index > 50 ? "after" : "same");
      }
    }
  }
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
