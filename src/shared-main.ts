#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SharedClient, type SharedMethod, type MeshEvent } from "copilot-mesh";
import { Protocol, type IncomingCommand } from "./protocol.js";
import { sendCoreEvent } from "./core-events.js";

const credential = (name: string, required = true): string | undefined => {
  const file = process.env[name];
  if (!file && required) throw new Error(`${name} must name a private credential file.`);
  return file ? readFileSync(file, "utf8").trim() : undefined;
};
const client = new SharedClient({
  url: process.env.MESH_SHARED_URL ?? "",
  token: credential("MESH_SHARED_TOKEN_FILE")!,
  ...(process.env.MESH_TUNNEL_TOKEN_FILE ? { tunnelToken: credential("MESH_TUNNEL_TOKEN_FILE")! } : {}),
});
let closed = false;
let cursor = Number(process.env.MESH_SHARED_CURSOR ?? 0);
let journalId = process.env.MESH_SHARED_JOURNAL_ID ?? "";
const cancellation = new AbortController();
const requestIds = new Map<string, string>();
const rpc = (command: IncomingCommand, method: SharedMethod, args: unknown[]) => {
  let id = requestIds.get(command.id);
  if (!id) { id = randomUUID(); requestIds.set(command.id, id); }
  return client.command(method, args, id);
};
const protocol = new Protocol(handle, async () => detach(), ["permission.respond", "session.abort"]);
let catalogSignature = "";
const catalog = (conversations: Awaited<ReturnType<SharedClient["snapshot"]>>["conversations"]) => {
  const signature = JSON.stringify(conversations);
  if (signature !== catalogSignature) {
    catalogSignature = signature;
    protocol.send("shared.catalog", { conversations });
  }
};
function detach() {
  closed = true;
  cancellation.abort();
  protocol.stop();
}
const snapshot = async (requestId?: string) => {
  const state = await client.snapshot();
  catalog(state.conversations);
  protocol.send("hello", { shared: true, status: state.status,
    recoverableAgents: state.state.runs.filter(run => run.status !== "active") },
  requestId ? { requestId, done: true } : {});
  return state;
};

async function handle(command: IncomingCommand): Promise<void> {
  const p = (command.payload ?? {}) as Record<string, unknown>;
  const field = (name: string) => {
    if (typeof p[name] !== "string" || !p[name]) throw new Error(`${command.type} requires ${name}.`);
    return p[name];
  };
  const complete = () => protocol.send("request.complete", { type: command.type }, { requestId: command.id, done: true });
  if (command.type === "shutdown") { detach(); return; }
  if (command.type === "history.chunk.rendered") {
    complete(); return;
  }
  if (command.type === "shared.history") {
    const memberId = field("target");
    try {
      const page = await client.history(memberId, typeof p.before === "number" ? p.before : undefined);
      protocol.send("shared.history.page", { ...page, older: typeof p.before === "number" },
        { memberId, requestId: command.id, done: true });
    } catch (error) {
      protocol.send("shared.history.error", { message: error instanceof Error ? error.message : String(error) },
        { memberId, requestId: command.id, done: true });
    }
    return;
  }
  if (command.type === "shared.history.records") {
    const memberId = field("target");
    if (!Array.isArray(p.ids) || p.ids.some(id => typeof id !== "string")) throw new Error("Record IDs required.");
    try {
      const records = [];
      for (const id of new Set(p.ids as string[])) records.push(await client.record(memberId, id));
      protocol.send("shared.history.records", { records }, { memberId, requestId: command.id, done: true });
    } catch (error) {
      protocol.send("shared.history.error", { message: error instanceof Error ? error.message : String(error), live: true },
        { memberId, requestId: command.id, done: true });
    }
    return;
  }
  if (command.type === "shared.history.content") {
    const memberId = field("target");
    try {
      const chunk = await client.content(memberId, field("recordId"), Number(p.offset), Number(p.revision));
      protocol.send("shared.history.content", { ...chunk, id: p.recordId }, { memberId, requestId: command.id, done: true });
    } catch (error) {
      protocol.send("shared.history.error", { message: error instanceof Error ? error.message : String(error), content: true },
        { memberId, requestId: command.id, done: true });
    }
    return;
  }
  if (command.type === "hello" || command.type === "runtime.status") { await snapshot(command.id); return; }
  if (command.type === "state.snapshot") {
    protocol.send("state.snapshot", (await client.snapshot()).state, { requestId: command.id, done: true }); return;
  }
  if (command.type === "sessions.list") {
    const state = await client.snapshot();
    const sessions = state.conversations.map(s => {
      return { ...s, summary: `${s.live ? "[Attach live]" : "[Resume stopped]"} ${s.displayName}${s.primary ? " (host primary)" : ""}`,
        inUse: false, modifiedAgoSeconds: 0 };
    });
    protocol.send("sessions.list", { sessions }, { requestId: command.id, done: true }); return;
  }
  if (command.type === "session.resume") {
    const id = field("sessionId");
    let state = await client.snapshot();
    if (!state.status.agents.some(a => a.sessionId === id)) {
      const stored = state.conversations.find(s => s.sessionId === id);
      if (!stored) throw new Error("Session is not managed by this shared host.");
      await rpc(command, "resumeSession", [stored.runId]);
      state = await snapshot();
    }
    const live = state.status.agents.find(a => a.sessionId === id);
    if (!live) throw new Error("Session did not become live.");
    protocol.send("shared.selected", live);
    complete(); return;
  }
  if (command.type === "mode.primary") {
    const created = await rpc(command, "createConversation", []);
    await snapshot();
    protocol.send("shared.selected", created);
    complete(); return;
  }
  if (command.type === "agents.spawn") {
    const agents = await rpc(command, "spawnAgents", [{
      agents: p.agents, callerCanTalkTo: p.callerCanTalkTo ?? [], callerCanObserve: p.callerCanObserve ?? [],
    }]);
    protocol.send("agents.spawned", { agents }, { requestId: command.id, done: true });
    return;
  }
  const simple: Record<string, { method: SharedMethod; args: unknown[] }> = {
    "shared.rename": { method: "renameConversation", args: [p.target, p.title] },
    "prompt.send": { method: "sendUserPrompt", args: [p.target, p.content] },
    "session.abort": { method: "abort", args: [p.target] },
    "agent.resume": { method: "resumeSession", args: [p.runId] },
    "agent.stop": { method: "stopSession", args: [p.target ?? p.agentId, p.confirmBusy === true] },
    "permission.respond": { method: "respondPermission", args: [p.requestId, p.approved === true] },
  };
  const operation = simple[command.type];
  if (operation) {
    await rpc(command, operation.method, operation.args);
    complete(); return;
  }
  const reads: Record<string, [SharedMethod, unknown[], string, string]> = {
    "models.list": ["listModels", [], "models.list", "models"],
    "commands.list": ["listCommands", [p.target], "commands.list", "commands"],
    "command.invoke": ["invokeCommand", [p.target, p.name, p.input], "command.result", "result"],
    "model.list": ["modelState", [p.target], "model.list", "state"],
    "model.switch": ["switchModel", [p.target, p.modelId], "model.changed", "model"],
    "reasoning.list": ["reasoningState", [p.target], "reasoning.list", "state"],
    "reasoning.switch": ["setReasoningEffort", [p.target, p.reasoningEffort], "reasoning.changed", "result"],
    "mcp.list": ["listMcp", [p.target], "mcp.list", "servers"],
    "mcp.show": ["listMcp", [p.target], "mcp.show", "servers"],
    "mcp.tools": ["listMcpTools", [p.target, p.serverName], "mcp.tools", "tools"],
    "mcp.enable": ["setMcpEnabled", [p.target, p.serverName, true], "mcp.changed", "state"],
    "mcp.disable": ["setMcpEnabled", [p.target, p.serverName, false], "mcp.changed", "state"],
    "mcp.reload": ["reloadMcp", [p.target], "mcp.reloaded", "serverCount"],
    "tasks.list": ["listTasks", [p.target], "tasks.list", "tasks"],
    "tasks.progress": ["taskProgress", [p.target, p.taskId], "tasks.progress", "progress"],
    "tasks.cancel": ["cancelTask", [p.target, p.taskId], "tasks.cancelled", "cancelled"],
    "session.cancel-background": ["cancelAllBackgroundAgents", [p.target], "background.cancelled", "count"],
  };
  const read = reads[command.type];
  if (read) {
    const [method, args, type, key] = read;
    const result = await rpc(command, method, args);
    protocol.send(type, { ...p, [key]: result }, { requestId: command.id, done: true });
    return;
  }
  if (command.type === "history.tool_result") {
    const result = await rpc(command, "historicalToolResult", [field("target"), field("toolCallId")]);
    protocol.send("history.tool_result", { toolCallId: p.toolCallId, ...result as Record<string, unknown> },
      { requestId: command.id, memberId: field("target"), done: true });
    return;
  }
  throw new Error(`${command.type} is not supported by shared-host mode.`);
}

async function main() {
  const state = await client.snapshot();
  protocol.start();
  const reset = (current: typeof state) => {
    cursor = current.cursor;
    journalId = current.journalId;
    protocol.send("shared.reset", { journalId });
    for (const approval of current.approvals) sendCoreEvent(protocol, approval);
  };
  if (journalId !== state.journalId || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > state.cursor) reset(state);
  protocol.send("shared.cursor", { cursor, journalId });
  protocol.send("host.ready", { shared: true });
  await snapshot();
  let disconnected = false;
  while (!closed) {
    try {
      if (disconnected) {
        const current = await snapshot();
        if (current.journalId !== journalId || cursor > current.cursor) reset(current);
        protocol.send("shared.approvals", { approvals: current.approvals });
        protocol.send("shared.connection", { connected: true });
        disconnected = false;
      }
      const batch = await client.updates(cursor, cancellation.signal);
      const changes = new Map<string, Set<string>>();
      for (const entry of batch.events) {
        if (entry.sequence !== cursor + 1) {
          reset(await client.snapshot());
          throw new Error("Event gap: rebuilding the local view.");
        }
        const event = entry.event;
        const fields = { sharedSequence: entry.sequence };
        if (event.type === "transcript.changed") {
          const ids = changes.get(event.payload.target) ?? new Set<string>();
          for (const id of event.payload.ids ?? []) ids.add(id);
          changes.set(event.payload.target, ids);
        } else if (event.type === "permission.resolved") protocol.send(event.type, event.payload, fields);
        else if (event.type === "host.catalog") {
          // The following snapshot updates this client's conversation list.
        } else if (event.type === "host.stopping" || event.type === "host.failed") {
          protocol.send("host.error", { message: `Shared ${event.type}; sessions are not owned by this editor.` });
        } else {
          sendCoreEvent({ send: (type, payload, context) => protocol.send(type, payload, { ...context, ...fields }) }, event as MeshEvent);
        }
        for (const [target, ids] of changes) {
          protocol.send("shared.history.changed", { ids: [...ids] }, { memberId: target });
        }
        cursor = entry.sequence;
      }
      const current = await client.snapshot();
      if (current.journalId !== journalId || cursor > current.cursor) reset(current);
      protocol.send("shared.cursor", { cursor, journalId });
      catalog(current.conversations);
    } catch (error) {
      if (closed) break;
      if (cursor > 0 && error instanceof Error && error.message.includes("HTTP 400")) {
        cursor = 0;
        journalId = "";
      }
      if (!disconnected) protocol.send("shared.connection", { connected: false,
        message: "Shared host disconnected. Retrying event catch-up; commands are not automatically resubmitted." });
      disconnected = true;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
process.once("SIGTERM", detach);
process.once("SIGINT", detach);
main().catch(() => {
  console.error("Cannot connect to shared Mesh host. Check URL and private credential files.");
  detach();
  process.exitCode = 1;
});
