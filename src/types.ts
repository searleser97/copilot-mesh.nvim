export type { DynamicAgentDefinition, SpawnAgentsRequest } from "copilot-mesh";

export const PROTOCOL_VERSION = 1 as const;

export interface ProtocolMessage {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: string;
  ts: string;
  requestId?: string;
  runId?: string;
  memberId?: string;
  target?: string;
  sequence?: number;
  done?: boolean;
  payload?: unknown;
}
