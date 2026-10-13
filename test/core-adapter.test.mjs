import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { sendCoreEvent } from "../dist/core-events.js";
import { CoreRuntime } from "../dist/core-runtime.js";
import { MeshHost } from "copilot-mesh";

test("domain events restore legacy names and rendering hints without changing payloads", () => {
  const routes = [
    ["assistant.delta", "conversation.delta", "conversation"],
    ["assistant.message", "conversation.message", "conversation"],
    ["reasoning.delta", "activity.delta", "activity"],
    ["reasoning.message", "activity.reasoning", "activity"],
    ["sdk.event", "activity.event", "activity"],
    ["permission.requested", "permission.requested", "status"],
    ["session.history", "session.history", "conversation"],
    ["mailbox.delivered", "mailbox.delivered", "messages"],
    ["agent.loading", "agent.loading", "status"],
    ["agent.ready", "agent.ready", "status"],
    ["member.foreground_idle", "member.foreground_idle", "status"],
    ["member.recovery_warning", "member.recovery_warning", "activity"],
    ["runtime.ready", "runtime.ready", undefined],
  ];
  for (const [type, expected, target] of routes) {
    const payload = { sentinel: true };
    const context = { runId: "run", memberId: "agent:id", sequence: 9, done: false };
    let sent;
    sendCoreEvent({ send: (...args) => { sent = args; } },
      { v: 1, id: "id", ts: "time", type, payload, context });
    assert.deepEqual(sent, [expected, payload,
      { ...context, ...(target === undefined ? {} : { target }) }]);
    assert.equal(sent[1], payload);
    assert.equal("target" in context, false);
  }
});

test("adapter preserves synchronous errors and results at the core boundary", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-adapter-"));
  const host = new MeshHost({ workspace, databasePath: join(workspace, "state.sqlite"), onEvent() {} });
  t.after(async () => {
    await host.shutdown("test");
    rmSync(workspace, { recursive: true, force: true });
  });
  const adapter = new CoreRuntime(host);
  assert.deepEqual(adapter.status().agents, []);
  assert.deepEqual(adapter.recoverableAgentRuns(), []);
  assert.equal(adapter.respondPermission("unknown", true), false);
  assert.throws(() => adapter.acknowledgeHistoryChunk("missing", 0), /not awaiting/);
  await assert.rejects(adapter.abort("invalid"), /agent:<uuid>/);
});

test("real core-backed NDJSON host reports invalid requests and shuts down deterministically", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "mesh-stdio-"));
  const env = { ...process.env, NATIVE_COPILOT_FILE_HOOK_DIRECTORIES: "[]" };
  delete env.NATIVE_COPILOT_E2E_PROFILE;
  delete env.NATIVE_COPILOT_RUNTIME_COMMAND_RESOLVER;
  const child = spawn(process.execPath, [resolve("dist", "main.js"),
    "--workspace", workspace, "--db", join(workspace, "state.sqlite")],
  { env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const timeout = setTimeout(() => child.kill(), 15000);
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes; });
  t.after(async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    rmSync(workspace, { recursive: true, force: true });
  });
  child.stdin.end([
    "{bad",
    JSON.stringify({ v: 9, id: "version", type: "hello" }),
    JSON.stringify({ v: 1, id: "hello", type: "hello" }),
    JSON.stringify({ v: 1, id: "unknown", type: "not-a-method" }),
    JSON.stringify({ v: 1, id: "approval", type: "permission.respond",
      payload: { requestId: "missing", approved: true } }),
    JSON.stringify({ v: 1, id: "shutdown", type: "shutdown" }),
    "",
  ].join("\n"));
  const events = [];
  for await (const line of createInterface({ input: child.stdout })) events.push(JSON.parse(line));
  assert.equal((await closed)[0], 0, stderr);
  assert.equal(events.filter(e => e.type === "protocol.error").length, 2);
  assert.equal(events.find(e => e.type === "hello").payload.databasePath, join(workspace, "state.sqlite"));
  assert.equal(events.find(e => e.requestId === "unknown").type, "request.error");
  assert.equal(events.find(e => e.requestId === "approval").payload.applied, false);
  assert.equal(events.at(-1).type, "host.shutdown");
});
