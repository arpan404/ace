import { apply, createThreadState, type Fact, type Key, type ThreadState } from "@ace/core";
import { applyDelivery, createThreadView } from "@ace/projection";
import type {
  DeliveryEvent,
  EventPayload,
  Interaction,
  InteractionId,
  Thread,
  ThreadView,
} from "@ace/protocol";

/** One scripted thread: core state for status derivation plus the complete projected view. */
export class ThreadHost {
  readonly state: ThreadState;
  readonly view: ThreadView;
  /** Item id to creation sequence; the cursor that history pages are keyed by. */
  readonly creation = new Map<string, number>();
  private counter = 0;
  constructor(thread: Thread) {
    this.state = createThreadState({
      threadId: thread.id,
      // Scripts never send liveness ticks, so silence must not mark agents unresponsive.
      config: { provider: thread.provider, silenceMs: 24 * 60 * 60 * 1000 },
    });
    this.view = createThreadView(thread);
  }
  get id(): string {
    return this.state.threadId;
  }
  /** Fold one adapter fact through core. Scripts are our own code, so a rejected fact is a bug. */
  fold(fact: Fact, now: number): EventPayload[] {
    const events = apply(this.state, fact, {
      now,
      ids: { next: (kind) => `${this.id}.${kind}.${++this.counter}` },
    });
    for (const event of events)
      if (
        event.type === "item.created" &&
        event.item.type === "notice" &&
        event.item.raw.some((raw) => raw.type === "core.rejected_fact")
      )
        throw new Error(`Core rejected scripted fact ${fact.type}: ${event.item.text}`);
    return events;
  }
  record(event: DeliveryEvent): void {
    applyDelivery(this.view, {
      type: "events",
      subscriptionId: "host",
      afterSeq: this.view.seq,
      throughSeq: event.seq,
      events: [event],
    });
    if (event.payload.type === "item.created") this.creation.set(event.payload.item.id, event.seq);
  }
  interaction(key: Key): Interaction | undefined {
    return Object.hasOwn(this.state.interactions, key) ? this.state.interactions[key] : undefined;
  }
  interactionKey(id: InteractionId): Key | undefined {
    for (const [key, interaction] of Object.entries(this.state.interactions))
      if (interaction.id === id) return key;
    return undefined;
  }
}
