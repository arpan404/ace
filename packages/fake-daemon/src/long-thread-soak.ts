import {
  applyDelivery,
  applyThreadListEvent,
  createThreadListView,
  createThreadView,
} from "@ace/projection";
import {
  AgentId,
  CommandId,
  DeviceId,
  EventId,
  HostId,
  ItemId,
  RunId,
  type ClientMessage,
  type Command,
  type CommandResult,
  type DeliveryEvent,
  type EventPayload,
  type Item,
  type ItemsPage,
  type ServerMessage,
  type SubscriptionScope,
  type ThreadListView,
  type ThreadView,
} from "@ace/protocol";
import { Connection, type Host, type Wire } from "./connection.ts";
import { SyntheticHistory } from "./long-thread-soak-history.ts";
import { LongThreadReads, type LiveTurn } from "./long-thread-soak-reads.ts";
import type { MultiDayThreadOptions } from "./scenarios/multi-day-thread.ts";
import { replyUnsupported, type FakeWireSession } from "./services-wire.ts";
import { windowSnapshot } from "./window.ts";

/*
 * A daemon for the long-thread performance run (ADR 0056, ADR 0062): the synthetic multi-day
 * thread of a million items, its turn index, item windows, search, catch-up and read cursors,
 * all served on demand from `SyntheticHistory`. Optionally a live turn keeps adding items at a
 * fixed rate, so following, Jump to live and its count are measured against a moving end.
 */

export interface LongThreadSoakOptions {
  clock(): number;
  shape?: MultiDayThreadOptions;
  /** Items the snapshot carries (the daemon's window). */
  windowItems?: number;
}

export class LongThreadSoak implements Host {
  readonly hostId = HostId.parse("long-thread-host");
  readonly duplicateEvents = false;
  readonly history: SyntheticHistory;
  private reads: LongThreadReads;
  private options: LongThreadSoakOptions;
  private connections = new Set<Connection>();
  private list: ThreadListView = createThreadListView();
  private seq: number;
  private live: LiveTurn;
  private snapshotView: ThreadView | undefined;
  private creation = new Map<string, number>();
  constructor(options: LongThreadSoakOptions) {
    this.options = options;
    this.history = new SyntheticHistory(options.shape ?? {});
    this.seq = this.history.end;
    const ordinal = this.history.shape.turns + 1;
    this.live = {
      ordinal,
      runId: RunId.parse(`${this.history.threadId}.run.${ordinal}`),
      startSeq: this.history.end,
      items: [],
      started: false,
    };
    this.reads = new LongThreadReads(
      this.history,
      () => this.live,
      () => this.seq,
    );
    for (const event of this.history.prelude()) applyThreadListEvent(this.list, event);
  }
  get threadId(): string {
    return this.history.threadId;
  }
  get head(): number {
    return this.seq;
  }
  get token(): string {
    return "long-thread-token";
  }
  /** Items added to the live turn so far. */
  get liveItems(): number {
    return this.live.items.length;
  }
  accepts(credential: { token?: string | undefined }): boolean {
    return credential.token === this.token;
  }
  connect(wire: Wire): Connection {
    const connection = new Connection(this, wire);
    this.connections.add(connection);
    return connection;
  }
  release(connection: Connection): void {
    this.connections.delete(connection);
  }
  service(message: ClientMessage, connection: Connection): boolean {
    return this.reads.handle(message, connection.deviceId, connection.push);
  }
  session(send: (reply: ServerMessage) => void): FakeWireSession {
    return { close() {}, handle: async (request) => replyUnsupported(request, send) };
  }

  /** The thread's newest items, built from the last turns (and the live one) once. */
  private view(): ThreadView {
    if (this.snapshotView) return this.snapshotView;
    const view = createThreadView(structuredClone(this.history.thread));
    const apply = (event: DeliveryEvent) => {
      if (event.threadId !== view.thread.id) return;
      applyDelivery(view, {
        type: "events",
        subscriptionId: "long-thread",
        afterSeq: view.seq,
        throughSeq: event.seq,
        events: [event],
      });
      if (event.payload.type === "item.created")
        this.creation.set(event.payload.item.id, event.seq);
    };
    for (const event of this.history.prelude()) apply(event);
    const want = this.options.windowItems ?? 200;
    let from = this.history.shape.turns;
    for (let held = 0; from > 1 && held < want; from--) held += this.history.itemCount(from);
    for (let ordinal = from; ordinal <= this.history.shape.turns; ordinal++)
      for (const event of this.history.turn(ordinal).events) apply(event);
    this.snapshotView = view;
    return view;
  }

  snapshot(scope: SubscriptionScope): ThreadView | ThreadListView | undefined {
    if (scope.kind === "threads") return { ...structuredClone(this.list), seq: this.seq };
    if (scope.threadId !== this.threadId) return undefined;
    const view = this.view();
    const snapshot = windowSnapshot(view, this.creation, this.options.windowItems ?? 200, this.seq);
    // Older history continues below the window, all the way to the first turn.
    const first = snapshot.itemOrder[0];
    if (first !== undefined) snapshot.itemsBefore = this.creation.get(first) ?? null;
    return snapshot;
  }
  replay(): DeliveryEvent[] {
    return [];
  }
  page(threadId: string, before: number, limit: number): ItemsPage | undefined {
    if (threadId !== this.threadId) return undefined;
    return this.reads.page(before, limit);
  }
  command(command: Command): CommandResult {
    const payload = command.payload;
    if (payload.type === "thread.markRead")
      return this.reads.markRead(command.id, payload, command.deviceId, this.options.clock());
    return { commandId: command.id, ok: false, error: "unsupported_by_long_thread_soak" };
  }

  /**
   * Seeds where a device last read the thread: just before turn `ordinal` began, at the time
   * it began (the catch-up card on opening).
   */
  seedRead(deviceId: string, ordinal: number): void {
    const summary = this.history.summary(ordinal);
    this.reads.markRead(
      CommandId.parse(`seed-read-${deviceId}`),
      {
        type: "thread.markRead",
        threadId: this.history.threadId,
        lastSeenSeq: summary.startSeq - 1,
      },
      DeviceId.parse(deviceId),
      summary.startedAt,
    );
  }

  /** Add `count` items to the live turn (starting it first), published in one batch. */
  pump(count: number): void {
    const now = this.options.clock();
    const root = this.history.shape.root;
    const payloads: EventPayload[] = [];
    if (!this.live.started) {
      this.live.started = true;
      payloads.push(
        {
          type: "run.started",
          run: {
            id: this.live.runId,
            threadId: this.history.threadId,
            agentId: root,
            ordinal: this.live.ordinal,
            trigger: "user",
            state: "active",
            startedAt: now,
          },
        },
        { type: "agent.status", agentId: root, status: { state: "working", activity: "tool" } },
        { type: "thread.updated", status: { state: "working", agents: 1 } },
      );
    }
    for (let n = 0; n < count; n++) {
      const number = this.live.items.length + n + 1;
      const item: Item = {
        id: ItemId.parse(`${this.history.threadId}.live.${number}`),
        agentId: AgentId.parse(root),
        runId: this.live.runId,
        createdAt: now,
        complete: true,
        type: "notice",
        level: "info",
        text: `Live checkpoint ${this.live.ordinal}, finding ${number}: replay window holds after the resume.`,
        raw: [],
      };
      payloads.push({ type: "item.created", item });
    }
    const events = payloads.map((payload): DeliveryEvent => {
      const seq = ++this.seq;
      return {
        seq,
        id: EventId.parse(`live-${seq}`),
        at: now,
        threadId: this.history.threadId,
        payload,
      };
    });
    const view = this.view();
    for (const event of events) {
      applyDelivery(view, {
        type: "events",
        subscriptionId: "long-thread",
        afterSeq: view.seq,
        throughSeq: event.seq,
        events: [event],
      });
      if (event.payload.type === "item.created") {
        this.creation.set(event.payload.item.id, event.seq);
        this.live.items.push({ item: event.payload.item, seq: event.seq });
      }
      applyThreadListEvent(this.list, event);
    }
    this.trim(view);
    for (const connection of this.connections) connection.publish(events, this.seq);
  }
  /** The snapshot's view keeps a bounded window; older items come back through pages. */
  private trim(view: ThreadView): void {
    const keep = (this.options.windowItems ?? 200) * 2;
    if (view.itemOrder.length <= keep * 2) return;
    const dropped = view.itemOrder.slice(0, view.itemOrder.length - keep);
    view.itemOrder = view.itemOrder.slice(-keep);
    for (const id of dropped) {
      delete view.items[id];
      this.creation.delete(id);
    }
  }
}
