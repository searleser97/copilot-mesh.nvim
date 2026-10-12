import type { SessionEvent } from "@github/copilot-sdk";

const STALL_AFTER_MS = 60_000;
const REPEAT_AFTER_MS = 300_000;

export type HealthRecord = Record<string, string | number | boolean | undefined>;

/** Observes liveness only: silence never authorizes aborting or replaying a prompt. */
export class SessionHealth {
  private readonly sends = new Set<string>();
  private awaitingStart = false;
  private lastProgressAt: number;
  private lastEventAt: number;
  private lastEventType = "connected";
  private lastWarningAt: number | undefined;
  private recoveryPhase: string | undefined;
  private recoveryStartedAt: number | undefined;
  private recoveryEndedAt: number | undefined;
  private lastRequestId: string | undefined;
  private lastSdkMessageId: string | undefined;

  constructor(
    private readonly record: (entry: HealthRecord) => void,
    private readonly now = Date.now,
  ) {
    this.lastProgressAt = this.lastEventAt = now();
  }

  get waiting(): boolean {
    return this.awaitingStart || this.sends.size > 0;
  }

  get progressSilenceMs(): number {
    return this.now() - this.lastProgressAt;
  }

  sendStarted(requestId: string): void {
    this.sends.add(requestId);
    this.awaitingStart = true;
    this.lastRequestId = requestId;
    this.lastSdkMessageId = undefined;
    this.lastProgressAt = this.now();
    this.record({ operation: "send.started", requestId });
  }

  sendSettled(requestId: string, sdkMessageId?: string): void {
    this.sends.delete(requestId);
    if (this.lastRequestId === requestId) {
      this.lastSdkMessageId = sdkMessageId;
      if (sdkMessageId === undefined) this.awaitingStart = false;
    }
    this.record({
      operation: sdkMessageId === undefined ? "send.failed" : "send.accepted",
      requestId,
      sdkMessageId,
    });
  }

  event(event: SessionEvent): boolean {
    this.lastEventAt = this.now();
    this.lastEventType = event.type;
    // Usage/keepalive notifications do not prove the foreground request is progressing.
    const progress = event.agentId === undefined && (
      event.type.startsWith("assistant.") && event.type !== "assistant.usage"
      || event.type.startsWith("tool.execution_")
      || event.type === "session.idle"
      || event.type === "session.error"
      || event.type === "session.shutdown"
      || event.type === "permission.requested"
      || event.type === "permission.completed"
    );
    if (!progress) return false;
    this.lastProgressAt = this.now();
    if (event.type.startsWith("assistant.") ||
      ["session.idle", "session.error", "session.shutdown"].includes(event.type)) {
      this.awaitingStart = false;
    }
    const resumed = this.lastWarningAt !== undefined;
    this.lastWarningAt = undefined;
    if (resumed || [
      "assistant.turn_start", "assistant.turn_end", "session.idle", "session.error",
      "session.shutdown", "tool.execution_start", "tool.execution_complete",
    ].includes(event.type)) {
      this.record({
        operation: resumed ? "progress.resumed" : "sdk.event",
        eventId: event.id,
        eventType: event.type,
        sdkTimestamp: event.timestamp,
        ...(event.type === "session.error" ? {
          errorType: event.data.errorType,
          statusCode: event.data.statusCode,
          providerCallId: event.data.providerCallId,
          serviceRequestId: event.data.serviceRequestId,
        } : {}),
      });
    }
    return resumed;
  }

  recovery(phase: "events" | "permissions" | "paused" | "complete" | "failed"): void {
    if (phase === "events") {
      this.recoveryStartedAt = this.now();
      this.recoveryEndedAt = undefined;
    } else if (phase !== "permissions") {
      this.recoveryEndedAt = this.now();
    }
    this.recoveryPhase = phase;
    if (phase === "failed") {
      this.record({ operation: "recovery.failed", ...this.snapshot() });
    }
  }

  snapshot(): HealthRecord {
    return {
      requestId: this.lastRequestId,
      sdkMessageId: this.lastSdkMessageId,
      awaitingStart: this.awaitingStart,
      pendingSends: this.sends.size,
      lastEventType: this.lastEventType,
      eventSilenceMs: this.now() - this.lastEventAt,
      progressSilenceMs: this.progressSilenceMs,
      recoveryPhase: this.recoveryPhase,
      recoveryElapsedMs: this.recoveryStartedAt === undefined
        ? undefined : (this.recoveryEndedAt ?? this.now()) - this.recoveryStartedAt,
      stalled: this.lastWarningAt !== undefined,
    };
  }

  check(busy: boolean): HealthRecord | undefined {
    const now = this.now();
    if (!(busy || this.waiting) || now - this.lastProgressAt < STALL_AFTER_MS) return;
    if (this.lastWarningAt !== undefined && now - this.lastWarningAt < REPEAT_AFTER_MS) return;
    this.lastWarningAt = now;
    const snapshot = this.snapshot();
    this.record({ operation: "progress.stalled", ...snapshot });
    return snapshot;
  }
}
