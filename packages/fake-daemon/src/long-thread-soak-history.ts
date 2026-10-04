import {
  applyDelivery,
  createThreadView,
  digestContributions,
  emptyTurnDigest,
  itemDigestContribution,
  itemMessagePreview,
} from "@ace/projection";
import {
  EventId,
  type DeliveryEvent,
  type ThreadId,
  type Item,
  type Thread,
  type ThreadView,
  type TurnDigest,
  type TurnSummary,
} from "@ace/protocol";
import {
  multiDayItemsBefore,
  multiDayPrelude,
  multiDayShape,
  multiDayTurn,
  multiDayTurnItems,
  type MultiDayShape,
  type MultiDayThreadOptions,
  type SyntheticThreadEvent,
} from "./scenarios/multi-day-thread.ts";

/*
 * A synthetic multi-day thread (`multiDayThread`) served without holding it: each turn owns a
 * fixed block of creation sequences, so any item's sequence is known without replaying what
 * came before, and the turns a request needs are regenerated on demand. A million-item thread
 * costs a few cached turns and one digest per turn (computed the first time it is asked for).
 */

/** One regenerated turn: its events with their sequences and its items with deltas folded. */
export interface SyntheticTurn {
  ordinal: number;
  events: DeliveryEvent[];
  /** Main-thread items in creation order, with their creation sequences. */
  items: { item: Item; seq: number }[];
  /** Items of the linked child threads the turn started. */
  childItems: { item: Item; seq: number; threadId: ThreadId }[];
  /** Whole command output by item (an item keeps only its tail; search reads all of it). */
  outputs: Map<string, string>;
}

/** Turns kept regenerated; windows and pages ask for the same neighbours again and again. */
const cachedTurns = 6;

export class SyntheticHistory {
  readonly shape: MultiDayShape;
  /** Creation sequences each turn owns; a turn's k-th event has `ordinal * stride + k`. */
  readonly stride: number;
  readonly thread: Thread;
  private turns = new Map<number, SyntheticTurn>();
  private digests: (TurnDigest | undefined)[];
  private summaries: (TurnSummary | undefined)[];
  constructor(options: MultiDayThreadOptions) {
    this.shape = multiDayShape(options);
    const perTurn = multiDayTurnItems(this.shape, 1) + 64;
    this.stride = 2 ** Math.ceil(Math.log2(perTurn));
    const prelude = [...multiDayPrelude(this.shape)][0]?.payload;
    if (prelude?.type !== "thread.created") throw new Error("Synthetic thread has no prelude");
    this.thread = prelude.thread;
    this.digests = Array.from({ length: this.shape.turns + 1 }, () => undefined);
    this.summaries = Array.from({ length: this.shape.turns + 1 }, () => undefined);
  }
  get threadId(): ThreadId {
    return this.shape.id;
  }
  /** The sequence after the last synthetic turn, where live events continue. */
  get end(): number {
    return (this.shape.turns + 1) * this.stride;
  }
  /** The turn whose block holds `seq` (0 is the prelude), clamped to the synthetic turns. */
  turnAt(seq: number): number {
    return Math.max(0, Math.min(this.shape.turns, Math.floor(seq / this.stride)));
  }
  firstItemSeq(ordinal: number): number {
    return ordinal * this.stride;
  }
  itemCount(ordinal: number): number {
    return multiDayTurnItems(this.shape, ordinal);
  }
  itemsBefore(ordinal: number): number {
    return multiDayItemsBefore(this.shape, ordinal);
  }

  /** The prelude's events: the thread and its root agent. */
  prelude(): DeliveryEvent[] {
    return [...multiDayPrelude(this.shape)].map((event, index) => this.delivery(event, index + 1));
  }

  private delivery(event: SyntheticThreadEvent, seq: number): DeliveryEvent {
    return {
      seq,
      id: EventId.parse(`synthetic-${seq}`),
      at: event.at,
      threadId: event.threadId,
      payload: event.payload,
    };
  }

  turn(ordinal: number): SyntheticTurn {
    const cached = this.turns.get(ordinal);
    if (cached) {
      this.turns.delete(ordinal);
      this.turns.set(ordinal, cached);
      return cached;
    }
    let k = 0;
    const events: DeliveryEvent[] = [];
    for (const event of multiDayTurn(this.shape, ordinal))
      events.push(this.delivery(event, ordinal * this.stride + k++));
    // Fold deltas into their items the way a client's projection does.
    const view = scratchView(this.thread);
    for (const event of this.prelude()) fold(view, event);
    const children = new Map<string, ThreadView>();
    const creation = new Map<string, number>();
    const outputs = new Map<string, string>();
    for (const event of events) {
      if (event.payload.type === "item.created") creation.set(event.payload.item.id, event.seq);
      if (event.payload.type === "item.delta" && event.payload.field === "output")
        outputs.set(
          event.payload.itemId,
          (outputs.get(event.payload.itemId) ?? "") + event.payload.append,
        );
      if (event.threadId === this.threadId) fold(view, event);
      else if (event.payload.type === "thread.created")
        children.set(event.threadId, scratchView(event.payload.thread));
      else {
        const child = children.get(event.threadId);
        if (child) fold(child, event);
      }
    }
    const items = view.itemOrder.flatMap((id) => {
      const item = view.items[id];
      const seq = creation.get(id);
      return item && seq !== undefined ? [{ item, seq }] : [];
    });
    const childItems = [...children.values()].flatMap((child) =>
      child.itemOrder.flatMap((id) => {
        const item = child.items[id];
        const seq = creation.get(id);
        return item && seq !== undefined ? [{ item, seq, threadId: child.thread.id }] : [];
      }),
    );
    const turn = { ordinal, events, items, childItems, outputs };
    this.turns.set(ordinal, turn);
    if (this.turns.size > cachedTurns) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
    return turn;
  }

  /** The turn's digest, kept once computed (one small record per turn, like the daemon's index). */
  digest(ordinal: number): TurnDigest {
    const known = this.digests[ordinal];
    if (known) return known;
    const turn = this.turn(ordinal);
    const digest = digestContributions(turn.items.map(({ item }) => itemDigestContribution(item)));
    for (const event of turn.events) {
      const p = event.payload;
      if (event.threadId !== this.threadId) continue;
      if (p.type === "interaction.opened") digest.approvalsAsked++;
      if (p.type === "interaction.closed") {
        digest.approvalsAnswered++;
        if (p.autoReviewed) digest.approvalsAutoReviewed++;
      }
      if (p.type === "agent.created" && p.agent.childThreadId) digest.subagentsStarted++;
      if (p.type === "agent.status" && p.agentId !== this.shape.root) digest.subagentsFinished++;
      if (p.type === "usage.updated") {
        digest.inputTokens = (digest.inputTokens ?? 0) + (p.inputTokens ?? 0);
        digest.outputTokens = (digest.outputTokens ?? 0) + (p.outputTokens ?? 0);
      }
    }
    this.digests[ordinal] = digest;
    return digest;
  }

  /** The turn's summary, kept once computed (as the daemon's turn index persists it). */
  summary(ordinal: number): TurnSummary {
    const known = this.summaries[ordinal];
    if (known) return known;
    const summary = this.summarise(ordinal);
    this.summaries[ordinal] = summary;
    return summary;
  }
  private summarise(ordinal: number): TurnSummary {
    const turn = this.turn(ordinal);
    const first = turn.events[0];
    const last = turn.events.at(-1);
    const ask = turn.items.find(({ item }) => item.type === "message" && item.role === "user");
    const answer = turn.items.findLast(
      ({ item }) => item.type === "message" && item.role === "assistant",
    );
    const subagents = turn.events.flatMap((event) =>
      event.threadId === this.threadId &&
      event.payload.type === "agent.created" &&
      event.payload.agent.childThreadId
        ? [
            {
              agentId: event.payload.agent.id,
              threadId: event.payload.agent.childThreadId,
              name: event.payload.agent.name ?? "Worker",
              status: { state: "done" as const },
              startedAt: event.at,
              endedAt: last?.at ?? event.at,
              digest: emptyTurnDigest(),
            },
          ]
        : [],
    );
    return {
      threadId: this.threadId,
      ordinal,
      startSeq: first?.seq ?? ordinal * this.stride,
      endSeq: last?.seq ?? ordinal * this.stride,
      startedAt: first?.at ?? this.shape.startedAt,
      endedAt: last?.at ?? this.shape.startedAt,
      status: { state: "done" },
      outcome: "completed",
      initiatingMessagePreview: ask ? itemMessagePreview(ask.item) : "",
      latestAgentMessagePreview: answer ? itemMessagePreview(answer.item) : "",
      digest: this.digest(ordinal),
      subagents,
      subagentsTruncated: false,
    };
  }
}

function scratchView(thread: Thread): ThreadView {
  return createThreadView(structuredClone(thread));
}
function fold(view: ThreadView, event: DeliveryEvent): void {
  applyDelivery(view, {
    type: "events",
    subscriptionId: "synthetic",
    afterSeq: view.seq,
    throughSeq: event.seq,
    events: [event],
  });
}
