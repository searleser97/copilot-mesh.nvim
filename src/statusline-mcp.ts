#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ColorRegistry, defaultColorDatabase, validateSessionId } from "./session-colors.js";

const prefix = "copilot-mesh-";
const identity = z.string().refine(value => {
  try { validateSessionId(value); return true; } catch { return false; }
}, "Expected exact SDK conversation ID, not a target, alias, run ID or guessed current session");
const getArgs = z.object({ sessionId: identity }).strict();
const setArgs = getArgs.extend({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected #RRGGBB") });
const definitions = [
  { name: `${prefix}get-statusline-color`, schema: getArgs, readOnly: true,
    description: "Read a registered main conversation's color/expiry/cleared state without renewing it." },
  { name: `${prefix}set-statusline-color`, schema: setArgs, readOnly: false,
    description: "Set #RRGGBB for a registered main conversation, with automatic readable foreground. " +
      "Rejects colors actively leased to another session; re-enables a previously cleared color." },
  { name: `${prefix}clear-statusline-color`, schema: getArgs, readOnly: false,
    description: "Persistently disable a registered main conversation's tint and free its color. " +
      "Activity/restore will not re-enable it; set explicitly to re-enable." },
];
const targeting = " sessionId is caller-supplied targeting, NOT authenticated isolation. " +
  "Use only your own main SDK conversation ID, obtained from real_agent_get for your known actual " +
  "Mesh alias (sessionId field), or explicitly supplied by the user. Never guess an ID or use " +
  "a parent/peer ID. Subagents must not call these tools. Display support is not verified by this server.";

const flag = process.argv.indexOf("--database");
if (flag >= 0 && !process.argv[flag + 1]) throw new Error("--database requires a path");
const database = resolve(flag >= 0 ? process.argv[flag + 1]!
  : process.env.NATIVE_COPILOT_COLOR_DATABASE || defaultColorDatabase());
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(), params: z.unknown().optional(),
});
const callSchema = z.object({ name: z.string(), arguments: z.unknown().optional(),
  _meta: z.unknown().optional() }).strict();

function dispatch(method: string, params: unknown): unknown {
  switch (method) {
    case "initialize": {
      const version = z.object({ protocolVersion: z.string() }).passthrough().parse(params).protocolVersion;
      return {
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(version)
          ? version : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "copilot-mesh-statusline", version: "1.0.0" },
        instructions: targeting.trim(),
      };
    }
    case "ping": return {};
    case "tools/list": return { tools: definitions.map(tool => ({
      name: tool.name, description: tool.description + targeting,
      inputSchema: z.toJSONSchema(tool.schema),
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
    })) };
    case "tools/call": {
      let registry: ColorRegistry | undefined;
      try {
        const call = callSchema.parse(params);
        const tool = definitions.find(item => item.name === call.name);
        if (!tool) throw new Error(`Unknown tool: ${call.name}`);
        const args = tool.schema.parse(call.arguments ?? {});
        if (!existsSync(database)) throw new Error(
          `No session color registry at ${database}. Open a main conversation with the updated plugin first.`,
        );
        registry = new ColorRegistry(database, tool.readOnly);
        if (call.name === `${prefix}set-statusline-color`) {
          const values = setArgs.parse(args);
          registry.set(values.sessionId, values.color);
        } else if (call.name === `${prefix}clear-statusline-color`) registry.clear(args.sessionId);
        const result = { ...registry.get(args.sessionId), display: "not-verified",
          refresh: "Updated plugin hosts observe changes within 250ms; unsupported/disabled statuslines remain unchanged." };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      } finally {
        registry?.close();
      }
    }
    default: throw new Error("Method not found");
  }
}

// MCP stdio is newline-delimited JSON-RPC. Never log operational output to stdout.
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
  const message = requestSchema.safeParse(parsed);
  if (!message.success) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    continue;
  }
  const { id, method, params } = message.data;
  if (id === undefined) continue;
  try { write({ jsonrpc: "2.0", id, result: dispatch(method, params) }); }
  catch (error) { write({ jsonrpc: "2.0", id, error: {
    code: error instanceof z.ZodError ? -32602 : -32601,
    message: error instanceof Error ? error.message : String(error),
  } }); }
}
