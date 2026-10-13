import { join } from "node:path";
import { AgentDatabase } from "../dist/database.js";
import { AssistantResponseCorrelation, CopilotRuntime } from "../dist/runtime.js";
import { SessionEventOrder } from "../dist/session-event-order.js";
import { SessionHealth } from "../dist/session-health.js";

export function peerFixture(directory) {
  const db = new AgentDatabase(join(directory, "state.sqlite"), () => false);
  const emitted = [];
  const runtime = new CopilotRuntime(directory, db, (type, payload) => emitted.push({ type, payload }));
  clearInterval(runtime.recoveryTimer);
  runtime.refreshTasks = () => {};
  const sessions = {};
  for (const alias of ["recipient", "peer", "other"]) {
    const definition = {
      id: alias, displayName: alias, description: alias, task: "Wait.", prompt: "Wait.",
      permissions: { mode: "inherit" }, mcpServers: [], canTalkTo: [], canObserve: [],
    };
    const context = {
      agentId: alias, target: `agent:${alias}`, alias, runId: `${alias}-run`, definition,
      agent: runtime.resolveStoredDefinition(definition),
      mcpServers: new Set(), canTalkTo: new Set(alias === "recipient" ? [] : ["recipient"]),
      canObserve: new Set(),
    };
    db.createAgentRun(context.runId, alias, alias, JSON.stringify({
      definition, mcpServers: [], canTalkToAgentIds: [...context.canTalkTo], canObserveAgentIds: [],
    }), directory, process.pid);
    db.upsertSession(context.runId, `${alias}-session`, "connected");
    db.completeProvisionedAgentStartup(context.runId);
    runtime.agents.set(alias, context);
    runtime.aliasIndex.set(alias, alias);
    runtime.agentGenerations.set(alias, 1);
    const binding = {
      active: true, agentId: alias, target: context.target, runId: context.runId,
      generation: 1, sessionId: `${alias}-session`, transition: undefined,
    };
    runtime.sessionBindings.set(alias, binding);
    const sends = [];
    const live = {
      ...context, binding, generation: 1, availableMcpServers: new Set(),
      configSignature: runtime.sessionSignature(context, new Set()),
      busy: false, foregroundBusy: false, foregroundTurnSequence: 0,
      idleCycle: 1, mailboxDrainCycle: 0, sequence: 0, seenEventIds: new Set(),
      historicalToolResults: new Map(), aicUsed: 0, taskRefresh: 0,
      lastRecoveryAt: 0, lastEventAt: 0, recoveringEvents: false,
      recoveryPermissionRequests: new Map(), health: new SessionHealth(() => {}),
      eventOrder: new SessionEventOrder(), recoveryOrderingWarning: false, recoveryOrderingRevision: -1,
      responseCorrelation: new AssistantResponseCorrelation(),
      session: {
        sessionId: `${alias}-session`,
        send: async (options) => { sends.push(options); return `${alias}-${sends.length}`; },
      },
    };
    runtime.live.set(live.target, live);
    sessions[alias] = { context, live, sends };
  }
  function send(message, alias = "peer") {
    return runtime.createAgentMessagingTools(sessions[alias].context)
      .find((tool) => tool.name === "real_agent_send_message").handler({
        recipient: "recipient", message,
      });
  }
  const row = (id) => db.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  function cleanup() {
    if (runtime.shuttingDown && !db.db.isOpen) return;
    runtime.shuttingDown = true;
    for (const timer of runtime.mailboxDrainTimers.values()) clearTimeout(timer);
    for (const timer of runtime.mailboxRetryTimers.values()) clearTimeout(timer);
    db.close();
  }
  return { db, runtime, emitted, sessions, send, row, cleanup };
}
