import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_MS = 60_000;
const curated = ["#56b4e9", "#e69f00", "#009e73", "#cc79a7", "#f0e442", "#d55e00",
  "#9b8afb", "#80cdc1", "#f4a582", "#b8de69", "#c774e8", "#748cab"];

function rgb(hex: string): number[] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
export function foreground(bg: string): string {
  const [r, g, b] = rgb(bg).map(linear);
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
function lab(hex: string): number[] {
  const [r, g, b] = rgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const candidates = [...new Set([...curated, ...Array.from({ length: 216 }, (_, index) => {
  const levels = [64, 96, 128, 160, 192, 224];
  return "#" + [Math.floor(index / 36), Math.floor(index / 6) % 6, index % 6]
    .map(i => levels[i]!.toString(16)).join("");
})])];
export const COLOR_CAPACITY = candidates.length;

export function defaultColorDatabase(): string {
  return process.platform === "win32"
    ? resolve(process.env.LOCALAPPDATA ?? homedir(), "copilot-mesh.nvim", "session-colors.sqlite")
    : resolve(process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state"),
      "copilot-mesh.nvim", "session-colors.sqlite");
}

export interface SessionColor {
  sessionId: string;
  bg: string;
  fg: string;
  expiresAt: number;
}

/** UI-only leases: separate from the core's agent database and schema. */
export class ColorRegistry {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000");
      this.db.exec(`CREATE TABLE IF NOT EXISTS session_colors (
        session_id TEXT PRIMARY KEY,
        color TEXT NOT NULL CHECK(length(color) = 7),
        last_activity INTEGER NOT NULL
      ) STRICT`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  reserve(sessionId: string, now = Date.now()): SessionColor {
    if (!sessionId.trim() || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid session color identity or activity timestamp");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT session_id, color, last_activity FROM session_colors").all();
      for (const row of rows) {
        if (typeof row.session_id !== "string" || !row.session_id.trim() ||
          typeof row.color !== "string" || !candidates.includes(row.color) ||
          typeof row.last_activity !== "number" || !Number.isSafeInteger(row.last_activity) ||
          row.last_activity < 0) throw new Error("Corrupt session color reservation");
      }
      const own = rows.find(row => row.session_id === sessionId);
      const active = rows.filter(row => Number(row.last_activity) > now - LEASE_MS);
      if (new Set(active.map(row => row.color)).size !== active.length) {
        throw new Error("Conflicting session color reservations");
      }
      const live = active.filter(row => row.session_id !== sessionId);
      const used = new Set(live.map(row => String(row.color)));
      let color = own && !used.has(String(own.color)) ? String(own.color) : undefined;
      if (!color) color = curated.find(candidate => !used.has(candidate));
      if (!color) {
        const labs = [...used].map(lab);
        let best = -1;
        for (const candidate of candidates) {
          if (used.has(candidate)) continue;
          const position = lab(candidate);
          const distance = Math.min(...labs.map(other =>
            position.reduce((sum, value, i) => sum + (value - other[i]!) ** 2, 0)));
          if (distance > best) { best = distance; color = candidate; }
        }
      }
      if (!color) throw new Error(`All ${COLOR_CAPACITY} session colors have active seven-day leases`);
      const activity = Math.max(now, Number(own?.last_activity ?? 0));
      this.db.prepare(`INSERT INTO session_colors VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET color=excluded.color, last_activity=excluded.last_activity`)
        .run(sessionId, color, activity);
      this.db.exec("COMMIT");
      return { sessionId, bg: color, fg: foreground(color), expiresAt: activity + LEASE_MS };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.db.close(); }
}

type Send = (type: string, payload?: unknown) => void;
const activityEvents = new Set(["prompt.queued", "prompt.accepted", "assistant.delta", "assistant.message",
  "reasoning.delta", "reasoning.message", "conversation.delta", "conversation.message",
  "activity.delta", "activity.reasoning"]);

export class SessionColors {
  private registry?: ColorRegistry;
  private primary: { sessionId: string; target: string; runId: string | undefined } | undefined;
  private color: SessionColor | undefined;
  private lastAttempt = -Infinity;
  constructor(private readonly path: string | undefined, private readonly send: Send,
    private readonly clock = Date.now) {}

  event(type: string, payload: unknown, context?: { memberId?: string; runId?: string }): void {
    if (!this.path) return;
    const data = typeof payload === "object" && payload !== null
      ? payload as Record<string, unknown> : {};
    if (type === "session.loading" || (type === "agent.loading" && data.primary === true) ||
      (type === "agent.stopped" && data.target === this.primary?.target)) {
      this.primary = undefined;
      this.color = undefined;
      this.send("session.color", {});
    } else if (type === "primary.ready") {
      if (typeof data.sessionId !== "string" || typeof data.target !== "string") return;
      this.primary = { sessionId: data.sessionId, target: data.target, runId: context?.runId };
      this.renew();
    } else if (this.primary && context?.memberId === this.primary.target &&
      (!this.primary.runId || context.runId === this.primary.runId) &&
      (activityEvents.has(type) || ((type === "sdk.event" || type === "activity.event") &&
        ["tool.execution_start", "tool.execution_complete", "assistant.intent"]
          .includes(String(data.eventType)))) &&
      this.clock() - this.lastAttempt >= RENEW_MS) {
      this.renew();
    }
  }
  private renew(): void {
    if (!this.primary || !this.path) return;
    this.lastAttempt = this.clock();
    try {
      this.registry ??= new ColorRegistry(this.path);
      this.color = this.registry.reserve(this.primary.sessionId, this.lastAttempt);
      this.replay();
    } catch (error) {
      this.color = undefined;
      this.send("session.color", {});
      this.send("session.color.error", {
        message: `Session color registry ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  replay(): void {
    this.send("session.color", this.color && this.color.expiresAt > this.clock() ? this.color : {});
  }
  close(): void { this.registry?.close(); }
}
