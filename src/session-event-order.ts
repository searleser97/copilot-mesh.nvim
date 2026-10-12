import type { SessionEvent } from "@github/copilot-sdk";

type Position = { segment: number; index: number };
type Metadata = {
  parents: readonly string[];
  history?: Position;
  recovery?: Position;
};
type Batch = { events: readonly SessionEvent[]; sizes: readonly number[]; offset: number; cursor: string };
export type EventRelation = "before" | "after" | "same" | "unknown";

/** Uses SDK parent IDs and ordered batches, never timestamps or per-loop turn numbers. */
export class SessionEventOrder {
  private nodes = new Map<string, Metadata>();
  private segment = 0;
  private recoverySegment = 0;
  private recoveryIndex = 0;
  private previousRecoveryId: string | undefined;
  private batches: Batch[] = [];
  private unretainedIds = new Set<string>();
  watermark: string | undefined;
  revision = 0;
  private unresolvedId: string | undefined;

  copy(): SessionEventOrder {
    const copy = new SessionEventOrder();
    copy.nodes = new Map(this.nodes);
    copy.segment = this.segment;
    copy.recoverySegment = this.recoverySegment;
    copy.recoveryIndex = this.recoveryIndex;
    copy.previousRecoveryId = this.previousRecoveryId;
    copy.batches = this.batches.map((batch) => ({ ...batch }));
    copy.unretainedIds = new Set(this.unretainedIds);
    copy.watermark = this.watermark;
    copy.revision = this.revision;
    copy.unresolvedId = this.unresolvedId;
    return copy;
  }

  record(event: SessionEvent): void {
    const previous = this.nodes.get(event.id) ?? { parents: [] };
    const parent = event.parentId;
    if (!this.nodes.has(event.id) || parent && !previous.parents.includes(parent)) this.revision += 1;
    this.nodes.delete(event.id);
    this.nodes.set(event.id, {
      ...previous,
      parents: parent && !previous.parents.includes(parent)
        ? [...previous.parents, parent].slice(-3) : previous.parents,
    });
    while (this.nodes.size > 20_000) {
      const oldest = this.nodes.keys().next().value!;
      const node = this.nodes.get(oldest)!;
      this.nodes.delete(oldest);
      if (oldest === this.watermark || oldest === this.unresolvedId) this.nodes.set(oldest, node);
    }
  }

  recordHistory(events: readonly SessionEvent[]): number {
    const segment = ++this.segment;
    let previous: string | undefined;
    for (const [index, event] of events.entries()) {
      this.record(event);
      this.position(event.id, "history", { segment, index }, previous);
      previous = event.id;
    }
    return segment;
  }

  visitHistory(events: readonly SessionEvent[], handle: (event: SessionEvent) => void): void {
    const segment = this.recordHistory(events);
    let previous: string | undefined;
    for (const [index, event] of events.entries()) {
      // Restore evicted positions from this supplied ordered snapshot, not guessed ancestry.
      this.record(event);
      this.position(event.id, "history", { segment, index }, previous);
      handle(event);
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
    const batch = { events, cursor, offset: 0, sizes: events.map((event) => Buffer.byteLength(JSON.stringify(event))) };
    for (const event of events) this.unretainedIds.delete(event.id);
    if (events.length === 0 && this.batches.at(-1)?.events.length === 0) {
      this.batches[this.batches.length - 1] = batch;
    } else {
      this.batches.push(batch);
    }
  }

  private position(
    id: string, source: "history" | "recovery", position: Position, previous?: string,
  ): void {
    const node = this.nodes.get(id)!;
    if (node[source]?.segment !== position.segment || node[source]?.index !== position.index ||
      previous && !node.parents.includes(previous)) this.revision += 1;
    this.nodes.set(id, {
      ...node,
      [source]: position,
      parents: previous && previous !== id && !node.parents.includes(previous)
        ? [...node.parents, previous].slice(-3) : node.parents,
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
    return this.batches.reduce((count, batch) => count + batch.events.length - batch.offset, this.unretainedIds.size);
  }

  get pendingBytes(): number {
    return this.batches.reduce((count, batch) =>
      count + batch.sizes.slice(batch.offset).reduce((sum, size) => sum + size, 0), 0);
  }

  limitRetention(): boolean {
    let limited = false;
    while (this.pendingBytes > 8 * 1024 * 1024) {
      // Keep the committed checkpoint before these unapplied records; never mark them seen.
      const batch = this.batches.pop()!;
      for (const event of batch.events.slice(batch.offset)) this.unretainedIds.add(event.id);
      limited = true;
    }
    if (limited) {
      this.recoverySegment = 0;
      this.recoveryIndex = 0;
      this.previousRecoveryId = undefined;
    }
    return limited;
  }

  readCursor(committed: string | undefined): string | undefined {
    return this.batches.at(-1)?.cursor ?? committed;
  }

  drain(
    seen: ReadonlySet<string>,
    handle: (event: SessionEvent, historical: boolean) => void,
    commit: (cursor: string) => void,
  ): void {
    for (const id of this.unretainedIds) {
      if (seen.has(id)) this.unretainedIds.delete(id);
    }
    while (this.batches.length) {
      const batch = this.batches[0]!;
      while (batch.offset < batch.events.length) {
        const event = batch.events[batch.offset]!;
        if (!seen.has(event.id)) {
          this.record(event);
          const relation = this.relation(event.id);
          if (relation === "unknown") {
            this.unresolvedId = event.id;
            batch.events = batch.events.slice(batch.offset);
            batch.sizes = batch.sizes.slice(batch.offset);
            batch.offset = 0;
            return;
          }
          handle(event, relation === "before");
        }
        batch.offset += 1;
      }
      if (this.unretainedIds.size > 0) {
        batch.events = [];
        batch.sizes = [];
        batch.offset = 0;
        if (this.batches.length === 1) return;
      } else commit(batch.cursor);
      this.batches.shift();
    }
    if (this.unretainedIds.size === 0) this.unresolvedId = undefined;
  }
}
