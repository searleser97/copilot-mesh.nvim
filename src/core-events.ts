import type { MeshEvent } from "copilot-mesh";
import type { Protocol } from "./protocol.js";

const legacyNames: Readonly<Record<string, string>> = {
  "assistant.delta": "conversation.delta",
  "assistant.message": "conversation.message",
  "reasoning.delta": "activity.delta",
  "reasoning.message": "activity.reasoning",
  "sdk.event": "activity.event",
};

const renderTargets: Readonly<Record<string, string>> = {
  "prompt.queued": "activity",
  "prompt.failed": "activity",
  "prompt.accepted": "conversation",
  "environment.progress": "activity",
  "environment.loaded": "activity",
  "permission.requested": "status",
  "member.stalled": "activity",
  "member.recovery_resumed": "activity",
  "member.error": "activity",
  "tasks.error": "status",
  "member.recovery_warning": "activity",
  "environment.error": "activity",
  "tasks.changed": "status",
  "session.history": "conversation",
  "mailbox.queued": "messages",
  "startup.progress": "status",
  "session.identity": "activity",
  "member.state": "status",
  "session.metrics": "status",
  "recovery.historical_event": "activity",
  "member.progress": "activity",
  "agent.prompt": "conversation",
  "scheduled.prompt": "conversation",
  "schedule.created": "activity",
  "schedule.cancelled": "activity",
  "schedule.rearmed": "activity",
  "conversation.delta": "conversation",
  "conversation.message": "conversation",
  "activity.delta": "activity",
  "activity.reasoning": "activity",
  "member.turn_end": "status",
  "member.foreground_idle": "status",
  "system.notification": "activity",
  "activity.event": "activity",
  "environment.status": "activity",
  "primary.ready": "status",
  "agent.error": "activity",
  "session.loading": "status",
  "agent.stopped": "status",
  "mailbox.warning": "messages",
  "mailbox.failed": "messages",
  "mailbox.delivered": "messages",
  "agent.loading": "status",
  "agent.ready": "status",
};

/** Translate transport-neutral domain events into the established Neovim wire contract. */
export function sendCoreEvent(protocol: Pick<Protocol, "send">, event: MeshEvent): void {
  const type = legacyNames[event.type] ?? event.type;
  const target = renderTargets[type];
  protocol.send(type, event.payload, { ...event.context,
    ...(target === undefined ? {} : { target }),
  });
}
