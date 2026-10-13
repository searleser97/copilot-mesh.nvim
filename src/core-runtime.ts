import { MeshHost, type RuntimeAdapter, type RuntimeStatus, type SpawnAgentsRequest } from "copilot-mesh";

/** The Neovim dispatcher remains independent of the core's versioned method contract. */
export class CoreRuntime implements RuntimeAdapter {
  constructor(readonly host: MeshHost) {}
  shutdown(reason: string) { return this.host.shutdown(reason); }
  status(): RuntimeStatus { return this.host.request({ v: 1, method: "status", args: [] }); }
  recoverableAgentRuns() {
    return this.host.request({ v: 1, method: "recoverableAgentRuns", args: [] });
  }
  listModels() { return this.host.request({ v: 1, method: "listModels", args: [] }); }
  listSessions() { return this.host.request({ v: 1, method: "listSessions", args: [] }); }
  resumePrimarySession(id: string) { return this.host.request({ v: 1, method: "resumePrimarySession", args: [id] }); }
  historicalToolResult(target: string, id: string) {
    return this.host.request({ v: 1, method: "historicalToolResult", args: [target, id] });
  }
  acknowledgeHistoryChunk(id: string, index: number) {
    this.host.request({ v: 1, method: "acknowledgeHistoryChunk", args: [id, index] });
  }
  listCommands(target: string) { return this.host.request({ v: 1, method: "listCommands", args: [target] }); }
  invokeCommand(target: string, name: string, input?: string) {
    return this.host.request({ v: 1, method: "invokeCommand", args: [target, name, input] });
  }
  modelState(target: string) { return this.host.request({ v: 1, method: "modelState", args: [target] }); }
  switchModel(target: string, id: string) { return this.host.request({ v: 1, method: "switchModel", args: [target, id] }); }
  reasoningState(target: string) { return this.host.request({ v: 1, method: "reasoningState", args: [target] }); }
  setReasoningEffort(target: string, effort: string) {
    return this.host.request({ v: 1, method: "setReasoningEffort", args: [target, effort] });
  }
  listMcp(target: string) { return this.host.request({ v: 1, method: "listMcp", args: [target] }); }
  setMcpEnabled(target: string, name: string, enabled: boolean) {
    return this.host.request({ v: 1, method: "setMcpEnabled", args: [target, name, enabled] });
  }
  listMcpTools(target: string, name: string) {
    return this.host.request({ v: 1, method: "listMcpTools", args: [target, name] });
  }
  openPrimary() { return this.host.request({ v: 1, method: "openPrimary", args: [] }); }
  spawnAgents(request: SpawnAgentsRequest) {
    return this.host.request({ v: 1, method: "spawnAgents", args: [request] });
  }
  resumeAgent(id: string) { return this.host.request({ v: 1, method: "resumeAgent", args: [id] }); }
  stopAgent(id: string, reason?: string) {
    return this.host.request({ v: 1, method: "stopAgent", args: [id, reason] });
  }
  sendUserPrompt(target: string, content: string) {
    return this.host.request({ v: 1, method: "sendUserPrompt", args: [target, content] });
  }
  abort(target: string) { return this.host.request({ v: 1, method: "abort", args: [target] }); }
  reloadMcp(target: string) { return this.host.request({ v: 1, method: "reloadMcp", args: [target] }); }
  listTasks(target: string) { return this.host.request({ v: 1, method: "listTasks", args: [target] }); }
  taskProgress(target: string, id: string) {
    return this.host.request({ v: 1, method: "taskProgress", args: [target, id] });
  }
  cancelTask(target: string, id: string) {
    return this.host.request({ v: 1, method: "cancelTask", args: [target, id] });
  }
  respondPermission(id: string, approved: boolean) {
    return this.host.request({ v: 1, method: "respondPermission", args: [id, approved] });
  }
  cancelAllBackgroundAgents(target: string) {
    return this.host.request({ v: 1, method: "cancelAllBackgroundAgents", args: [target] });
  }
}
