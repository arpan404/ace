import { z } from "zod";
import { apply, createThreadState, type Fact, type Key, type ThreadState } from "@ace/core";
import { applyDelivery, createThreadView } from "@ace/projection";
import type {
  ContentPart,
  DeliveryEvent,
  EventPayload,
  FollowUpBehavior,
  Interaction,
  InteractionId,
  MessageContext,
  QueueSnapshot,
  Thread,
  ThreadView,
  TurnOptions,
} from "@ace/protocol";

/** A message waiting in the fake daemon's queue for the root agent to be free. */
export interface FakeQueued {
  /** The command id that queued it; the queue's message id. */
  key: string;
  text: string;
  input: ContentPart[];
  attachments?: import("@ace/protocol").Attachment[];
  context?: MessageContext | undefined;
  delivery: FollowUpBehavior;
  state: "queued" | "uncertain";
  model?: string;
  options?: TurnOptions;
}

/** One scripted thread: core state for status derivation plus the complete projected view. */
export class ThreadHost {
  readonly state: ThreadState;
  readonly view: ThreadView;
  /** Item id to creation sequence; the cursor that history pages are keyed by. */
  readonly creation = new Map<string, number>();
  /** Messages sent with `delivery: "queue"` while the root agent was busy, oldest first. */
  queued: FakeQueued[] = [];
  /** The queue's hold and revision, as `queue.get` and `queue.updated` report them. */
  readonly queue: Omit<QueueSnapshot, "threadId" | "messages"> = {
    revision: 0,
    paused: false,
    reason: null,
    resumeAt: null,
  };
  /** The queue changed since the last `queue.updated` was published. */
  queueDirty = false;
  nextSelection: { model?: string; options?: TurnOptions } | undefined;
  runOrdinal = 0;
  permissionParent: string | undefined;
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
    if (
      fact.type === "item.upsert" &&
      fact.draft.type === "message" &&
      fact.draft.origin?.kind === "interaction_answer" &&
      fact.draft.origin.interactionId
    ) {
      const interaction = this.interaction(fact.draft.origin.interactionId);
      if (interaction)
        fact = {
          ...fact,
          draft: { ...fact.draft, origin: { ...fact.draft.origin, interactionId: interaction.id } },
        };
    }
    if (fact.type === "item.upsert" && fact.draft.type === "notice" && fact.draft.toolCallId) {
      const linked = this.state.items[fact.draft.toolCallId];
      if (linked?.type === "tool_call")
        fact = {
          ...fact,
          draft: {
            ...fact.draft,
            toolCallId: linked.id,
            raw: (fact.draft.raw ?? []).map((raw) =>
              raw.type === "ace.screen.step" && "data" in raw
                ? Object.assign({}, raw, {
                    data: {
                      ...z.record(z.string(), z.unknown()).parse(raw.data),
                      toolCallId: linked.id,
                    },
                  })
                : raw,
            ),
          },
        };
    }
    const events = apply(this.state, fact, {
      now,
      ids: {
        next: (kind) =>
          kind === "item" && fact.type === "item.upsert" && fact.item.startsWith("input:")
            ? fact.item
            : `${this.id}.${kind}.${++this.counter}`,
      },
    });
    this.attachInput(fact, events);
    for (const event of events)
      if (
        event.type === "item.created" &&
        event.item.type === "notice" &&
        event.item.raw.some((raw) => raw.type === "core.rejected_fact")
      )
        throw new Error(`Core rejected scripted fact ${fact.type}: ${event.item.text}`);
    return events;
  }
  /**
   * Like the daemon, admission writes the person's item before its run exists (or while an
   * earlier run is still going); the root run started for that command takes it as its own, so
   * the transcript groups the ask with the turn answering it.
   */
  private attachInput(fact: Fact, events: EventPayload[]): void {
    if (fact.type !== "turn.started" || fact.agent !== this.state.rootKey) return;
    if (!fact.nativeTurnId?.startsWith("turn-")) return;
    const key = `input:${fact.nativeTurnId.slice("turn-".length)}`;
    const runId = this.state.agents[fact.agent]?.activeRun;
    const item = Object.hasOwn(this.state.items, key) ? this.state.items[key] : undefined;
    if (!runId || !item || item.runId === runId) return;
    const updated = { ...item, runId };
    this.state.items[key] = updated;
    events.push({ type: "item.updated", item: updated });
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
  /** Adapter keys of the agent with this id and, with `cascade`, its running descendants. */
  interruptKeys(agentId: string | undefined, cascade: boolean): Key[] {
    const entries = Object.entries(this.state.agents);
    const start = entries.find(([, record]) => record.agent.id === agentId);
    if (!start) return [];
    const keys: Key[] = [];
    const visit = (key: Key, id: string) => {
      if (this.state.agents[key]?.activeRun) keys.push(key);
      if (!cascade) return;
      for (const [child, record] of entries)
        if (record.agent.parentId === id) visit(child, record.agent.id);
    };
    visit(start[0], start[1].agent.id);
    // Children first, so a parent never ends while a child it waits on is still running.
    return keys.toReversed();
  }
  taskKey(id: string): Key | undefined {
    for (const [key, task] of Object.entries(this.state.tasks)) if (task.id === id) return key;
    return undefined;
  }
  interactionKey(id: InteractionId): Key | undefined {
    for (const [key, interaction] of Object.entries(this.state.interactions))
      if (interaction.id === id) return key;
    return undefined;
  }
}
