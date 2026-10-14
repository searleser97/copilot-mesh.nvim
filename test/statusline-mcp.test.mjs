import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ColorRegistry } from "../dist/session-colors.js";

// An actual stdio client: initialize, discover the server's schemas, then tools/call.
function client(path) {
  const child = spawn(process.execPath, [resolve("dist/statusline-mcp.js"), "--database", path]);
  const pending = new Map();
  let id = 0, buffer = "", stderr = "";
  child.stderr.on("data", value => stderr += value);
  child.stdout.on("data", value => {
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      for (const request of pending.values()) request.reject(new Error(stderr || "MCP server closed"));
      code === 0 ? done() : reject(new Error(stderr));
    });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  return { request, exited, close: () => child.stdin.end(),
    notify: method => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n") };
}
const name = verb => `copilot-mesh-${verb}-statusline-color`;
test("real stdio MCP discovery/get/set/clear, explicit targeting, errors and persistence", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-mcp-"));
  const path = join(root, "colors.sqlite");
  const c = client(path);
  try {
    const init = await c.request("initialize", { protocolVersion: "2025-06-18",
      capabilities: {}, clientInfo: { name: "mesh-test-client", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.match(init.result.instructions, /NOT authenticated/);
    c.notify("notifications/initialized");
    const tools = (await c.request("tools/list", {})).result.tools;
    assert.deepEqual(tools.map(x => x.name), ["get", "set", "clear"].map(name));
    for (const tool of tools) {
      assert.ok(tool.inputSchema.required.includes("sessionId"));
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const call = async (verb, args) => (await c.request("tools/call", { name: name(verb), arguments: args })).result;
    assert.equal((await call("get", { sessionId: "main" })).isError, true);
    assert.equal(existsSync(path), false, "get must not initialize a registry");
    let registry = new ColorRegistry(path);
    registry.reserve("main");
    const other = registry.reserve("other");
    registry.close();
    const bytes = readFileSync(path), mtime = statSync(path).mtimeMs;
    let result = await call("get", { sessionId: "main" });
    assert.equal(result.structuredContent.state, "assigned");
    assert.equal(result.structuredContent.display, "not-verified");
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mtimeMs, mtime);
    for (const args of [{}, { sessionId: "" }, { sessionId: "../path" }, { sessionId: "unknown" },
      { sessionId: "main", target: "child" }]) assert.equal((await call("get", args)).isError, true);
    assert.equal((await call("set", { sessionId: "main", color: "red" })).isError, true);
    assert.equal((await call("set", { sessionId: "main", color: other.bg })).isError, true);
    result = await call("set", { sessionId: "main", color: "#ABCDEF" });
    assert.equal(result.structuredContent.color.bg, "#abcdef");
    assert.equal((await call("clear", { sessionId: "main" })).structuredContent.state, "cleared");
    registry = new ColorRegistry(path);
    assert.equal(registry.reserve("main"), undefined);
    assert.equal(registry.reserve("replacement").bg, "#56b4e9");
    registry.close();
    assert.equal((await call("get", { sessionId: "main" })).structuredContent.state, "cleared");
    assert.equal((await call("set", { sessionId: "main", color: "#112233" })).structuredContent.state, "assigned");
    // The deliberately accepted tradeoff: caller input can target another registered main.
    assert.equal((await call("clear", { sessionId: "other" })).structuredContent.state, "cleared");
    assert.equal((await c.request("unsupported", {})).error.code, -32601);
    assert.deepEqual((await c.request("ping", {})).result, {});
  } finally {
    c.close();
    await c.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
