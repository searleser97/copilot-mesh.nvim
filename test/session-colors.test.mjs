import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ColorRegistry, SessionColors, LEASE_MS, COLOR_CAPACITY, defaultColorDatabase } from "../dist/session-colors.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mesh-colors-"));
  const closers = [];
  t.after(() => {
    for (const close of closers) close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path: join(root, "colors.sqlite"), closers };
}
function worker(path, id, now, cwd) {
  const module = pathToFileURL(resolve("dist/session-colors.js")).href;
  const code = `import {ColorRegistry} from ${JSON.stringify(module)};
    const r = new ColorRegistry(process.argv[1]);
    console.log(JSON.stringify(r.reserve(process.argv[2], Number(process.argv[3])))); r.close();`;
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, path, id, String(now)], { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", x => stdout += x);
    child.stderr.on("data", x => stderr += x);
    child.on("error", reject);
    child.on("close", code => code === 0 ? done(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test("independent processes and workspaces serialize distinct and same-ID leases; restart restores", async t => {
  const { root, path } = fixture(t);
  const colors = await Promise.all(Array.from({ length: 20 }, (_, i) => worker(path, `main-${i}`, 100, root)));
  assert.equal(new Set(colors.map(x => x.bg)).size, 20);
  const same = await Promise.all(Array.from({ length: 8 }, () => worker(path, "same", 110, tmpdir())));
  assert.equal(new Set(same.map(x => x.bg)).size, 1);
  assert.deepEqual(await worker(path, "main-0", 100, tmpdir()), colors[0]);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_colors WHERE session_id = 'same'").get().n, 1);
  db.close();
});

test("seven-day boundary, reclaim, expired restoration and concurrent renewal", async t => {
  const { path, root } = fixture(t);
  const registry = new ColorRegistry(path);
  const old = registry.reserve("old", 0);
  assert.notEqual(registry.reserve("other", LEASE_MS - 1).bg, old.bg);
  assert.equal(registry.reserve("new", LEASE_MS).bg, old.bg);
  assert.notEqual(registry.reserve("old", LEASE_MS).bg, old.bg);
  const available = registry.reserve("available", 0);
  assert.equal(registry.reserve("available", LEASE_MS).bg, available.bg);
  registry.close();
  const simultaneous = await Promise.all(["new", "old", "late"].map(id => worker(path, id, 2 * LEASE_MS, root)));
  assert.equal(new Set(simultaneous.map(x => x.bg)).size, 3);
});

test("bounded overflow has no collisions and all foregrounds meet WCAG AA contrast", t => {
  const { path, closers } = fixture(t);
  const registry = new ColorRegistry(path);
  closers.push(() => registry.close());
  const seen = new Set();
  for (let i = 0; i < COLOR_CAPACITY; i++) {
    const color = registry.reserve(String(i), 0);
    assert.ok(!seen.has(color.bg)); seen.add(color.bg);
    const channels = [1, 3, 5].map(k => parseInt(color.bg.slice(k, k + 2), 16) / 255)
      .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    const l = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    assert.ok((color.fg === "#000000" ? (l + .05) / .05 : 1.05 / (l + .05)) >= 4.5);
  }
  assert.throws(() => registry.reserve("excess", 0), /active seven-day leases/);
  assert.ok(registry.reserve("after-expiry", LEASE_MS));
});

test("corrupt and unwritable storage fail explicitly; no success fallback", t => {
  const { path, root } = fixture(t);
  writeFileSync(path, "corrupt");
  assert.throws(() => new ColorRegistry(path), /database/);
  assert.throws(() => new ColorRegistry(join(path, "child.sqlite")));
  const other = join(root, "bad-row.sqlite");
  const registry = new ColorRegistry(other);
  const db = new DatabaseSync(other);
  db.prepare("INSERT INTO session_colors VALUES ('main', '#xxxxxx', 0)").run();
  assert.throws(() => registry.reserve("new", 0), /Corrupt/);
  db.close(); registry.close();
  const readonly = join(root, "readonly.sqlite");
  new ColorRegistry(readonly).close();
  chmodSync(readonly, 0o444);
  let locked;
  try {
    assert.throws(() => {
      locked = new ColorRegistry(readonly);
      locked.reserve("new", 0);
    }, /readonly|read-only|permission/i);
  } finally {
    locked?.close();
    chmodSync(readonly, 0o666);
  }
});

test("disabled colors do not touch storage; storage errors clear identity and report their path", t => {
  const { path } = fixture(t);
  const emitted = [];
  const send = (type, payload) => emitted.push({ type, payload });
  const disabled = new SessionColors(undefined, send);
  disabled.event("primary.ready", { target: "main", sessionId: "id" });
  assert.equal(emitted.length, 0);
  assert.equal(existsSync(path), false);
  writeFileSync(path, "not sqlite");
  const broken = new SessionColors(path, send);
  broken.event("primary.ready", { target: "main", sessionId: "id" });
  assert.deepEqual(emitted[0], { type: "session.color", payload: {} });
  assert.equal(emitted[1].type, "session.color.error");
  assert.ok(emitted[1].payload.message.includes(path));
  assert.ok(defaultColorDatabase().endsWith("session-colors.sqlite"));
  broken.close();
});

test("only verified primary and live main work reserve/renew; replay and subagent events do not", t => {
  const { path, closers } = fixture(t);
  let now = 100;
  const emitted = [];
  const controller = new SessionColors(path, (type, payload) => emitted.push({ type, payload }), () => now);
  closers.push(() => controller.close());
  const main = { memberId: "agent:main", runId: "run1" };
  controller.event("session.identity", { sessionId: "premature" }, main);
  controller.event("agent.ready", { target: "agent:child", sessionId: "child" });
  assert.equal(emitted.length, 0);
  controller.event("primary.ready", { target: main.memberId, sessionId: "main" }, main);
  const first = emitted.at(-1).payload;
  now += 120_000;
  for (const kind of ["runtime.status", "session.history", "recovery.historical_event", "member.progress"]) {
    controller.event(kind, {}, main);
  }
  controller.event("assistant.delta", {}, { memberId: "agent:child", runId: "child" });
  controller.event("assistant.delta", {}, { ...main, runId: "old" });
  controller.replay();
  assert.equal(emitted.at(-1).payload.expiresAt, first.expiresAt);
  controller.event("assistant.delta", {}, main);
  assert.equal(emitted.at(-1).payload.expiresAt, now + LEASE_MS);
  const registry = new ColorRegistry(path);
  now += LEASE_MS;
  assert.equal(registry.reserve("reassigned", now).bg, first.bg);
  controller.replay();
  assert.deepEqual(emitted.at(-1).payload, {});
  controller.event("prompt.accepted", {}, main);
  assert.notEqual(emitted.at(-1).payload.bg, first.bg);
  controller.event("session.loading", {}, main);
  assert.deepEqual(emitted.at(-1).payload, {});
  controller.event("assistant.delta", {}, main);
  assert.deepEqual(emitted.at(-1).payload, {});
  registry.close();
});
