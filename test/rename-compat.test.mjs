import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { AgentDatabase } from "../dist/database.js";

for (const selection of ["default", "environment", "argument"]) {
  test(`renamed host preserves ${selection} database selection and stored session identity`, async (t) => {
    const artifacts = resolve(".e2e-artifacts", "rename-tests");
    mkdirSync(artifacts, { recursive: true });
    const directory = mkdtempSync(join(artifacts, "case-"));
    const databasePath = selection === "default"
      ? join(directory, "native-copilot", "state.sqlite")
      : join(directory, "explicit.sqlite");
    const db = new AgentDatabase(databasePath, () => true);
    db.createAgentRun("existing-run", "existing-agent", "worker",
      JSON.stringify({ definition: { id: "worker", enableFileHooks: true } }),
      directory, process.pid);
    db.upsertSession("existing-run", "existing-sdk-session", "connected");
    const before = db.snapshot();
    db.close();
    const env = {
      ...process.env,
      NATIVE_COPILOT_DATA_HOME: directory,
      NATIVE_COPILOT_E2E_PROFILE: "allow-all",
      NATIVE_COPILOT_FILE_HOOK_DIRECTORIES: "[]",
    };
    delete env.NATIVE_COPILOT_DATABASE;
    if (selection === "environment") env.NATIVE_COPILOT_DATABASE = databasePath;
    if (selection === "argument") env.NATIVE_COPILOT_DATABASE = join(directory, "ignored.sqlite");
    const args = [resolve("dist", "main.js"), "--workspace", directory];
    if (selection === "argument") args.push("--db", databasePath);
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const closed = once(child, "close");
    const timeout = setTimeout(() => child.kill(), 15_000);
    t.after(async () => {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      rmSync(directory, { recursive: true, force: true });
    });
    const lines = createInterface({ input: child.stdout });
    child.stdin.write(JSON.stringify({ v: 1, id: "hello", type: "hello" }) + "\n");
    let hello;
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === "hello") {
        hello = event.payload;
        child.stdin.end(JSON.stringify({ v: 1, id: "shutdown", type: "shutdown" }) + "\n");
      }
    }
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(hello?.databasePath, databasePath);
    assert.equal(hello.interruptedRuns, 0);
    const reopened = new AgentDatabase(databasePath, () => true);
    try {
      assert.deepEqual(reopened.snapshot(), before);
    } finally {
      reopened.close();
    }
    assert.equal(existsSync(join(directory, "copilot-mesh")), false);
    assert.equal(existsSync(join(directory, "ignored.sqlite")), false);
  });
}
