import type { SessionEvent } from "@github/copilot-sdk";

type Position = { segment: number; index: number };
type Metadata = {
  parents: readonly string[];
  history?: Position;
  recovery?: Position;
};
type Batch = { events: readonly SessionEvent[]; offset: number; cursor: string };
export type EventRelation = "before" | "after" | "same" | "unknown";

/** Uses SDK parent IDs and ordered batches, never timestamps or per-loop turn numbers. */
export class SessionEventOrder {
  private nodes = new Map<string, Metadata>();
  private segment = 0;
  private recoverySegment = 0;
  private recoveryIndex = 0;
  private previousRecoveryId: string | undefined;
  private batches: Batch[] = [];
  watermark: string | undefined;

  copy(): SessionEventOrder {
    const copy = new SessionEventOrder();
    copy.nodes = new Map(this.nodes);
    copy.segment = this.segment;
    copy.recoverySegment = this.recoverySegment;
    copy.recoveryIndex = this.recoveryIndex;
    copy.previousRecoveryId = this.previousRecoveryId;
    copy.batches = this.batches.map((batch) => ({ ...batch }));
    copy.watermark = this.watermark;
    return copy;
  }

  record(event: SessionEvent): void {
    const previous = this.nodes.get(event.id) ?? { parents: [] };
    const parent = event.parentId;
    this.nodes.set(event.id, {
      ...previous,
      parents: parent && !previous.parents.includes(parent)
        ? [...previous.parents, parent] : previous.parents,
    });
  }

  recordHistory(events: readonly SessionEvent[]): void {
    const segment = ++this.segment;
    let previous: string | undefined;
    for (const [index, event] of events.entries()) {
      this.record(event);
      this.position(event.id, "history", { segment, index }, previous);
      previous = event.id;
    }
  }

  enqueue(events: readonly SessionEvent[], cursor: string, expired: boolean): void {
    if (expired || this.recoverySegment === 0) {
      this.recoverySegment = ++this.segment;
      this.recoveryIndex = 0;
      this.previousRecoveryId = undefined;
    }
    for (const event of events) {
      this.record(event);
      const existing = this.nodes.get(event.id)?.recovery;
      const position = existing?.segment === this.recoverySegment
        ? existing : { segment: this.recoverySegment, index: this.recoveryIndex++ };
      const previousPosition = this.previousRecoveryId
        ? this.nodes.get(this.previousRecoveryId)?.recovery : undefined;
      this.position(event.id, "recovery", position,
        previousPosition && previousPosition.index < position.index
          ? this.previousRecoveryId : undefined);
      this.previousRecoveryId = event.id;
    }
    if (events.length === 0 && this.batches.at(-1)?.events.length === 0) {
      this.batches[this.batches.length - 1] = { events, cursor, offset: 0 };
    } else {
      this.batches.push({ events, cursor, offset: 0 });
    }
  }

  private position(
    id: string, source: "history" | "recovery", position: Position, previous?: string,
  ): void {
    const node = this.nodes.get(id)!;
    this.nodes.set(id, {
      ...node,
      [source]: position,
      parents: previous && previous !== id && !node.parents.includes(previous)
        ? [...node.parents, previous] : node.parents,
    });
  }

  private compare(left: string, right: string): number | undefined {
    const a = this.nodes.get(left);
    const b = this.nodes.get(right);
    for (const source of ["history", "recovery"] as const) {
      const x = a?.[source];
      const y = b?.[source];
      if (x && y && x.segment === y.segment) return x.index - y.index;
    }
    return undefined;
  }

  relation(id: string): EventRelation {
    const watermark = this.watermark;
    if (watermark === undefined) return "after";
    if (id === watermark) return "same";
    const direct = this.compare(id, watermark);
    if (direct !== undefined) return direct < 0 ? "before" : "after";
    const left = [id];
    const right = [watermark];
    const leftSeen = new Set<string>();
    const rightSeen = new Set<string>();
    // Bound missing-ancestry work, including malformed/cyclic dependency envelopes.
    for (let step = 0; step < 4096 && (left.length || right.length); step += 1) {
      const a = left.pop();
      if (a && !leftSeen.has(a)) {
        if (a === watermark) return "after";
        leftSeen.add(a);
        const comparison = this.compare(a, watermark);
        if (comparison !== undefined && comparison >= 0) return "after";
        if (comparison === undefined) left.push(...this.nodes.get(a)?.parents ?? []);
      }
      const b = right.pop();
      if (b && !rightSeen.has(b)) {
        if (b === id) return "before";
        rightSeen.add(b);
        const comparison = this.compare(id, b);
        if (comparison !== undefined && comparison <= 0) return "before";
        if (comparison === undefined) right.push(...this.nodes.get(b)?.parents ?? []);
      }
    }
    return "unknown";
  }

  advance(event: SessionEvent): void {
    if (event.agentId !== undefined) return;
    if ([
      "user.message", "assistant.turn_start", "assistant.turn_end", "assistant.idle",
      "session.idle", "session.error", "session.shutdown",
    ].includes(event.type)) this.watermark = event.id;
  }

  get pending(): number {
    return this.batches.reduce((count, batch) => count + batch.events.length - batch.offset, 0);
  }

  readCursor(committed: string | undefined): string | undefined {
    return this.batches.at(-1)?.cursor ?? committed;
  }

  drain(
    seen: ReadonlySet<string>,
    handle: (event: SessionEvent, historical: boolean) => void,
    commit: (cursor: string) => void,
  ): void {
    while (this.batches.length) {
      const batch = this.batches[0]!;
      while (batch.offset < batch.events.length) {
        const event = batch.events[batch.offset]!;
        if (!seen.has(event.id)) {
          const relation = this.relation(event.id);
          if (relation === "unknown") return;
          handle(event, relation === "before");
        }
        batch.offset += 1;
      }
      commit(batch.cursor);
      this.batches.shift();
    }
  }
}
