import { closedInteractions, endedRuns, endedTasks, endedAgents } from "./eviction.ts";
import { clipItem } from "./item-window.ts";
import { itemFinished } from "./item-finished.ts";
import { pageWindow } from "./page-window.ts";
import { MessageDeltas } from "./message-deltas.ts";
import { PageJournal } from "./page-journal.ts";
import {
  applyDelivery,
  inRootLane,
  mergeBySeq,
  usageSnapshotKey,
  rebuildAgentChildren,
  retainedTail,
} from "@ace/projection";
import { resumeTranscript } from "./snapshot-merge.ts";
import type {
  ThreadView,
  EventBatch,
  Progress,
  Item,
  ItemsFill,
  ItemsPage,
  SnapshotFill,
} from "@ace/protocol";
import type { Mirrorable, ThreadExport, ThreadSource } from "./api.ts";
import type { ThreadKey, ThreadReader } from "./readers.ts";
import { Notifications, type ChangeTap, type Selection } from "./observable.ts";
import { ClientError, type Limits } from "./types.ts";

export type { ThreadKey, ThreadReader } from "./readers.ts";

const emptyOrder: readonly string[] = [];
const agentOf = (record: Record<string, Item>) => (id: string) =>
  Object.hasOwn(record, id) ? record[id]?.agentId : undefined;
/** Finished: no longer streaming, and no tool call still waiting or running. */
const complete = (record: Record<string, Item>) => (id: string) =>
  itemFinished(Object.hasOwn(record, id) ? record[id] : undefined);
export class ThreadStore implements ThreadSource, Mirrorable<ThreadExport> {
  #messageDeltas = new MessageDeltas();
  #journal: PageJournal;
  #hydrated = new Map<string, number>();
  #creation = new Map<string, number>();
  #failure: ClientError | undefined;
  get error() {
    return this.#failure;
  }
  fail(error: ClientError): void {
    this.#failure = error;
    this.#notifications.emit(["error"]);
  }
  recover(): void {
    if (!this.#failure) return;
    this.#failure = undefined;
    this.#notifications.emit(["error"]);
  }
  #syncing = false;
  get syncing(): boolean {
    return this.#syncing;
  }
  /** Whether the subscription is catching up on what changed while it was away. */
  setSyncing(syncing: boolean): void {
    if (this.#syncing === syncing) return;
    this.#syncing = syncing;
    this.#notifications.emit(["sync"]);
  }
  #unconfirmed = false;
  /** The next snapshot replaces what is held (`replaceOnSnapshot`). */
  #replace = false;
  get unconfirmed(): boolean {
    return this.#unconfirmed;
  }
  /** Whether the store holds a copy the daemon has not confirmed (`ThreadReader.unconfirmed`). */
  setUnconfirmed(unconfirmed: boolean): void {
    if (this.#unconfirmed === unconfirmed) return;
    this.#unconfirmed = unconfirmed;
    this.#notifications.emit(["unconfirmed"]);
  }
  #view: ThreadView | undefined;
  #notifications: Notifications;
  #limits: Limits;
  #clipped = new Set<string>();
  #deleted = new Set<string>();
  deleted(id: string): boolean {
    return this.#deleted.has(id);
  }
  #counts = new Map<string, number>();
  constructor(limits: Limits) {
    this.#limits = limits;
    this.#journal = new PageJournal(limits);
    this.#notifications = new Notifications(limits.listeners);
  }
  get thread() {
    return this.#view?.thread;
  }
  get queue() {
    return this.#view?.queue;
  }
  get context() {
    const root = this.#view?.thread.rootAgentId;
    return root ? this.contextMeter(root) : undefined;
  }
  get order(): readonly string[] {
    return this.#view?.itemOrder ?? emptyOrder;
  }
  get cursor() {
    return this.#view?.seq;
  }
  get entitiesBefore() {
    return this.#view?.entitiesBefore;
  }
  get itemsBefore() {
    return this.#view?.itemsBefore;
  }
  /** Set while the snapshot held is cut short of a full one: what `items.fill` asks for. */
  get fillRequest(): SnapshotFill | undefined {
    return this.#trimmed ? undefined : this.#view?.fill;
  }
  /**
   * The store holds less than a full snapshot of the thread and is still owed the rest
   * (`ThreadReader.filling`). Select with `history`.
   */
  get filling(): boolean {
    return this.#view?.fill !== undefined;
  }
  /** The window has evicted items since its snapshot: a fill would no longer meet it. */
  #trimmed = false;
  /** The newest event about an agent this store did not hold, so it could not apply. */
  #missedAgentSeq = 0;
  /** Agents created by live events since the snapshot, with the sequence that created them. */
  #agentsCreated = new Map<string, number>();
  agentIds(): readonly string[] {
    return this.#view ? Object.keys(this.#view.agents) : emptyOrder;
  }
  runIds(): readonly string[] {
    return this.#view ? Object.keys(this.#view.runs) : emptyOrder;
  }
  children(agentId: string): readonly string[] {
    // Projection appends children in place, so never hand out its array.
    return [...(this.#own(this.#view?.agentChildren, agentId) ?? emptyOrder)];
  }
  interactionIds(): readonly string[] {
    return this.#view ? Object.keys(this.#view.interactions) : emptyOrder;
  }
  taskIds(): readonly string[] {
    return this.#view ? Object.keys(this.#view.backgroundTasks) : emptyOrder;
  }
  item(id: string) {
    return this.#own(this.#view?.items, id);
  }
  itemSeq(id: string): number | undefined {
    return this.#creation.get(id);
  }
  agent(id: string) {
    return this.#own(this.#view?.agents, id);
  }
  run(id: string) {
    return this.#own(this.#view?.runs, id);
  }
  interaction(id: string) {
    return this.#own(this.#view?.interactions, id);
  }
  task(id: string) {
    return this.#own(this.#view?.backgroundTasks, id);
  }
  contextMeter(id: string) {
    const meters = this.#view?.contextMeters;
    return meters && Object.hasOwn(meters, id) ? meters[id] : undefined;
  }
  usage(id: string) {
    return this.#own(this.#view?.usage, id);
  }
  usageSnapshot(key: string) {
    return this.#own(this.#view?.usageSnapshots, key);
  }
  truncated(id: string) {
    return this.#clipped.has(id);
  }
  edited(previous: Item, next: Item) {
    return this.#messageDeltas.edit(previous, next);
  }
  #own<T>(record: Record<string, T> | undefined, id: string): T | undefined {
    return record && Object.hasOwn(record, id) ? record[id] : undefined;
  }
  select<T>(
    keys: readonly ThreadKey[],
    selector: (reader: ThreadReader) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    return this.#notifications.select(keys, () => selector(this), equal);
  }
  observe(tap: ChangeTap): () => void {
    return this.#notifications.tap(tap);
  }
  /** Shares the store's own objects; a structured clone (postMessage) copies them. */
  export(): ThreadExport {
    const failure = this.#failure;
    const view = this.#view;
    return {
      ...(this.#syncing ? { syncing: true } : {}),
      ...(this.#unconfirmed ? { unconfirmed: true } : {}),
      error: failure && { code: failure.code, message: failure.message },
      view: view && {
        seq: view.seq,
        thread: view.thread,
        agents: view.agents,
        agentChildren: view.agentChildren,
        runs: view.runs,
        items: view.items,
        itemOrder: view.itemOrder,
        itemSeqs: Object.fromEntries(
          view.itemOrder.flatMap((id) => {
            const seq = this.#creation.get(id);
            return seq === undefined ? [] : [[id, seq]];
          }),
        ),
        itemsBefore: view.itemsBefore,
        ...(view.entitiesBefore ? { entitiesBefore: view.entitiesBefore } : {}),
        interactions: view.interactions,
        backgroundTasks: view.backgroundTasks,
        usage: view.usage,
        usageSnapshots: view.usageSnapshots,
        ...(view.queue && { queue: view.queue }),
        ...(view.contextMeters && { contextMeters: view.contextMeters }),
      },
      truncated: [...this.#clipped],
      deleted: [...this.#deleted],
    };
  }
  /**
   * Show a view read back from disk until the subscription's snapshot arrives (ADR 0030). It is
   * held like any transcript, so that snapshot resumes it by creation sequence or replaces it,
   * exactly as a resubscription's does. False when the store already holds a view or the
   * record is over this client's limits.
   */
  restore(view: ThreadView, truncated: readonly string[]): boolean {
    if (this.#view) return false;
    try {
      this.#install(view);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      return false;
    }
    for (const id of truncated) if (this.item(id)) this.#clipped.add(id);
    // Unconfirmed before anyone hears of it: a copy from disk never reads as the daemon's.
    this.#syncing = true;
    this.#unconfirmed = true;
    this.#notifications.emitAll();
    return true;
  }
  /**
   * The next snapshot replaces what is held instead of resuming it: what is held came from
   * another database, whose sequences say nothing about this one's (ADR 0128).
   */
  replaceOnSnapshot(): void {
    this.#replace = true;
  }
  /** Roughly what the store holds, in bytes. Linear in it: for cache boundaries, never deltas. */
  retainedBytes(): number {
    return JSON.stringify(this.export()).length * 2 + this.#journal.retainedBytes();
  }
  /** The daemon's own snapshot: what the store shows is confirmed. */
  snapshot(view: ThreadView): void {
    this.#install(view);
    this.#unconfirmed = false;
    this.#notifications.emitAll();
  }
  /** Take `view` as what the store holds, resuming the held transcript where it may. */
  #install(view: ThreadView): void {
    const runs = Object.keys(view.runs).length;
    if (runs > this.#limits.entities) endedRuns(view, runs - this.#limits.entities);
    if (view.itemOrder.length > 200 || Object.keys(view.items).length > 200)
      throw new ClientError("limit", "Snapshot item capacity exceeded");
    if (Object.keys(view.itemSeqs ?? {}).length > 200)
      throw new ClientError("limit", "Item cursor capacity exceeded");
    closedInteractions(
      view,
      Math.max(0, Object.keys(view.interactions).length - this.#limits.entities),
    );
    endedTasks(view, Math.max(0, Object.keys(view.backgroundTasks).length - this.#limits.entities));
    endedAgents(view, Math.max(0, Object.keys(view.agents).length - this.#limits.entities));
    // Parent indexes are derived from retained agents, never retained from stale wire references.
    rebuildAgentChildren(view);
    const counts = new Map<string, number>();
    // Entity collections must stay bounded without discarding tree status facts.
    for (const [name, record] of Object.entries({
      agents: view.agents,
      runs: view.runs,
      interactions: view.interactions,
      tasks: view.backgroundTasks,
      usage: view.usage,
      contextMeters: view.contextMeters ?? {},
      usageSnapshots: view.usageSnapshots,
    }))
      counts.set(name, Object.keys(record).length);
    // The daemon sends its window in creation order; that order is kept as given. A snapshot
    // answering a resubscription resumes what was held instead of replacing it (ADR 0062).
    const resumed = this.#resume(view);
    const creation = new Map<string, number>();
    for (const id of resumed?.kept ?? []) {
      const seq = this.#creation.get(id);
      const item = this.item(id);
      if (seq === undefined || !item) continue;
      creation.set(id, seq);
      if (!Object.hasOwn(view.items, id))
        Object.defineProperty(view.items, id, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    const clipped = new Set((resumed?.kept ?? []).filter((id) => this.#clipped.has(id)));
    for (const id of view.itemOrder) {
      const seq = view.itemSeqs?.[id];
      if (seq !== undefined) creation.set(id, seq);
    }
    if (resumed) {
      view.itemOrder = mergeBySeq(resumed.kept, view.itemOrder, (id) => creation.get(id));
      view.itemsBefore = resumed.before;
    }
    this.#view = view;
    this.#trimmed = false;
    this.#missedAgentSeq = 0;
    this.#agentsCreated.clear();
    this.#failure = undefined;
    this.#replace = false;
    this.#journal.reset(view.seq);
    this.#hydrated.clear();
    this.#creation = creation;
    this.#clipped = clipped;
    this.#deleted.clear();
    this.#counts = counts;
    delete view.itemSeqs;
    this.#trim();
    for (const id of view.itemOrder) this.#clip(id);
    // Sent only as a preview, its whole body owed by the fill: shown as cut until it lands.
    for (const id of view.fill?.whole ?? []) if (this.item(id)) this.#clipped.add(id);
  }
  /** What a held transcript keeps of itself when `view` arrives for the same thread. */
  #resume(view: ThreadView): ReturnType<typeof resumeTranscript> {
    const held = this.#view;
    if (this.#replace) return undefined;
    if (!held || held.thread.id !== view.thread.id || view.seq < held.seq) return undefined;
    const seqs = view.itemSeqs;
    if (!seqs) return undefined;
    return resumeTranscript(
      {
        order: held.itemOrder,
        seq: (id) => this.#creation.get(id),
        agentOf: agentOf(held.items),
        complete: complete(held.items),
        before: held.itemsBefore,
      },
      held.seq,
      {
        order: view.itemOrder,
        seq: (id) => (Object.hasOwn(seqs, id) ? seqs[id] : undefined),
        agentOf: agentOf(view.items),
        complete: complete(view.items),
        before: view.itemsBefore,
      },
      view.thread.rootAgentId,
    );
  }
  #copy<T>(record: Record<string, T>, id: string): void {
    const value = this.#own(record, id);
    // Entities are individually bounded. No full view or history copy on deltas.
    if (value !== undefined) record[id] = { ...value };
  }
  #capacity(name: string, exists: boolean, keys?: Set<ThreadKey>): void {
    if (exists) return;
    let count = (this.#counts.get(name) ?? 0) + 1;
    if (count > this.#limits.entities && this.#view) {
      const batch = Math.ceil(this.#limits.entities / 4);
      if (name === "agents") count -= endedAgents(this.#view, batch, keys);
      else if (name === "usageSnapshots") {
        for (const id of Object.keys(this.#view.usageSnapshots).slice(0, batch)) {
          delete this.#view.usageSnapshots[id];
          keys?.add(`usageSnapshot:${id}`);
          count--;
        }
      } else if (name === "runs") count -= endedRuns(this.#view, batch, keys);
      else if (name === "interactions") count -= closedInteractions(this.#view, batch, keys);
      else if (name === "tasks") count -= endedTasks(this.#view, batch, keys);
    }
    this.#counts.set(name, count);
  }
  delivery(message: EventBatch | Progress): "applied" | "ignored" | "gap" {
    const view = this.#view;
    if (!view) return "gap";
    if (message.throughSeq <= view.seq) return "ignored";
    if (message.afterSeq !== view.seq) return "gap";
    if (message.type === "events")
      for (const event of message.events) {
        if (event.threadId !== view.thread.id) throw new ClientError("protocol");
        this.#journal.record(event);
      }
    const admitted = new Set<string>();
    const sequential =
      message.type === "events"
        ? message.events.filter((event) => {
            const payload = event.payload;
            const itemId =
              payload.type === "item.created" || payload.type === "item.updated"
                ? payload.item.id
                : payload.type === "item.delta" || payload.type === "item.deleted"
                  ? payload.itemId
                  : undefined;
            if (itemId && event.seq <= (this.#hydrated.get(itemId) ?? -1)) return false;
            // An item's place is its first upsert's sequence; a repeated create never moves it.
            if (payload.type === "item.created" && !this.#creation.has(payload.item.id))
              this.#creation.set(payload.item.id, event.seq);
            if (payload.type === "item.created") {
              admitted.add(payload.item.id);
              return true;
            }
            if (payload.type === "item.updated")
              return !!this.item(payload.item.id) || admitted.has(payload.item.id);
            if (payload.type === "item.delta")
              return !!this.item(payload.itemId) || admitted.has(payload.itemId);
            return true;
          })
        : [];
    const keys = new Set<ThreadKey>(["cursor"]);
    for (const event of sequential) {
      const p = event.payload;
      let appended = false;
      switch (p.type) {
        case "thread.created":
        case "thread.updated":
        case "thread.client.updated":
          view.thread = { ...view.thread };
          keys.add("thread");
          break;
        case "agent.created":
          this.#agentsCreated.set(p.agent.id, event.seq);
          if (!keys.has(`agent:${p.agent.id}`))
            this.#capacity("agents", !!this.agent(p.agent.id), keys);
          if (p.agent.origin === "root") {
            view.thread = { ...view.thread };
            keys.add("thread");
          }
          keys.add(`agent:${p.agent.id}`);
          keys.add("agents");
          break;
        case "agent.status":
        case "agent.updated":
          if (!this.agent(p.agentId)) this.#missedAgentSeq = event.seq;
          this.#copy(view.agents, p.agentId);
          keys.add(`agent:${p.agentId}`);
          if (p.type === "agent.updated" && (p.parentId !== undefined || p.spawnedBy !== undefined))
            keys.add("agents");
          break;
        case "run.started":
          if (!keys.has(`run:${p.run.id}`)) this.#capacity("runs", !!this.run(p.run.id), keys);
          keys.add(`run:${p.run.id}`);
          break;
        case "run.ended":
          this.#copy(view.runs, p.runId);
          keys.add(`run:${p.runId}`);
          break;
        case "item.created":
        case "item.updated":
          this.#deleted.delete(p.item.id);
          if (p.type === "item.updated" && !this.item(p.item.id)) break;
          if (!this.item(p.item.id)) {
            view.itemOrder = [...view.itemOrder];
            keys.add("order");
          }
          keys.add(`item:${p.item.id}`);
          break;
        case "item.deleted":
          this.#deleted.delete(p.itemId);
          this.#deleted.add(p.itemId);
          while (this.#deleted.size > this.#limits.entities) {
            const oldest = this.#deleted.values().next().value;
            if (oldest === undefined) break;
            this.#deleted.delete(oldest);
          }
          this.#clipped.delete(p.itemId);
          this.#hydrated.delete(p.itemId);
          this.#creation.delete(p.itemId);
          keys.add(`item:${p.itemId}`);
          keys.add("order");
          keys.add("history");
          break;
        case "item.delta":
          {
            const item = this.item(p.itemId);
            if (item?.type === "message" && p.field === "text") {
              view.items[p.itemId] = this.#messageDeltas.append(
                item,
                p.append,
                this.#limits.text,
                this.#limits.items,
                () => this.#clipped.add(p.itemId),
              );
              appended = true;
            } else if (item?.type === "tool_call")
              view.items[p.itemId] = {
                ...item,
                call: { ...item.call, detail: { ...item.call.detail } },
              };
            else if (item) view.items[p.itemId] = { ...item };
          }
          keys.add(`item:${p.itemId}`);
          break;
        case "interaction.opened":
          if (!keys.has(`interaction:${p.interaction.id}`))
            this.#capacity("interactions", !!this.interaction(p.interaction.id), keys);
          keys.add(`interaction:${p.interaction.id}`);
          keys.add("interactions");
          break;
        case "interaction.closed":
          this.#copy(view.interactions, p.interactionId);
          keys.add(`interaction:${p.interactionId}`);
          // `interactions` changes when one opens or closes, so lists of open requests follow
          // one key instead of one per interaction.
          keys.add("interactions");
          break;
        case "background_task.started":
          if (!keys.has(`task:${p.task.id}`)) this.#capacity("tasks", !!this.task(p.task.id), keys);
          keys.add(`task:${p.task.id}`);
          keys.add("tasks");
          break;
        case "background_task.updated":
          this.#copy(view.backgroundTasks, p.taskId);
          keys.add(`task:${p.taskId}`);
          break;
        case "queue.updated":
          keys.add("queue");
          break;
        case "context_meter.updated":
          if (!keys.has(`context:${p.meter.agentId}`))
            this.#capacity("contextMeters", !!this.contextMeter(p.meter.agentId));
          keys.add(`context:${p.meter.agentId}`);
          break;
        case "usage.updated": {
          if (p.usageScope === "provider_session" || p.usageScope === "model_session") {
            const key = usageSnapshotKey(p);
            if (!keys.has(`usageSnapshot:${key}`))
              this.#capacity("usageSnapshots", !!this.usageSnapshot(key));
            keys.add(`usageSnapshot:${key}`);
          } else {
            if (!keys.has(`usage:${p.agentId}`)) this.#capacity("usage", !!this.usage(p.agentId));
            keys.add(`usage:${p.agentId}`);
          }
          break;
        }
      }
      const result = applyDelivery(
        view,
        appended
          ? {
              type: "progress",
              subscriptionId: message.subscriptionId,
              afterSeq: view.seq,
              throughSeq: event.seq,
            }
          : {
              type: "events",
              subscriptionId: message.subscriptionId,
              afterSeq: view.seq,
              throughSeq: event.seq,
              events: [event],
            },
      );
      if (result.kind !== "applied") return result.kind;
      if (p.type === "item.created" || p.type === "item.updated") this.#clip(p.item.id);
      else if (p.type === "item.delta" && !appended) this.#clip(p.itemId);
    }
    view.seq = message.throughSeq;
    const evicted = this.#trim();
    if (evicted.length) {
      keys.add("order");
      keys.add("history");
      for (const id of evicted) keys.add(`item:${id}`);
    }
    this.#notifications.emit(keys);
    return "applied";
  }
  /**
   * Merge an older page read with cursor `before`. A page for a cursor the window has since
   * left (trimmed past by live items, or paged further) is stale: admitting it would leave a hole.
   */
  page(page: ItemsPage, before: number): void {
    const view = this.#view;
    if (!view) throw new ClientError("offline");
    if (page.threadId !== view.thread.id) throw new ClientError("protocol");
    const items = this.#journal.reconcile(page, view.seq);
    if (view.itemsBefore !== before) return;
    const window = pageWindow(
      view.itemOrder,
      this.#creation,
      { ...page, items },
      this.#limits.items,
    );
    const keys = new Set<ThreadKey>();
    for (const item of items)
      if (window.admitted.has(item.id)) {
        Object.defineProperty(view.items, item.id, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        this.#hydrated.set(item.id, Math.max(page.seq, view.seq));
        const seq = page.itemSeqs?.[item.id];
        if (seq !== undefined) this.#creation.set(item.id, seq);
        keys.add(`item:${item.id}`);
        this.#clip(item.id);
      }
    if (window.order !== view.itemOrder) {
      view.itemOrder = [...window.order];
      keys.add("order");
    }
    // Null means the oldest item was reached. A duplicate response cannot undo that fact.
    const next =
      view.itemsBefore === null || window.before === undefined ? view.itemsBefore : window.before;
    if (view.itemsBefore !== next) {
      view.itemsBefore = next;
      keys.add("history");
    }
    this.#notifications.emit(keys);
  }
  /**
   * Become what a full snapshot holds, given what it holds beyond the small one held (the
   * answer to `request`, this store's `fillRequest`): its items in its order, with the bodies
   * the small snapshot lacked or only previewed, and its agents. Items and agents created live
   * since the answer was read stay. "stale" when the answer is too old to apply (an event about
   * an agent it does not carry arrived after it was read): ask again. Ignored once another
   * snapshot came or the window evicted items.
   */
  fill(answer: ItemsFill, request: SnapshotFill): "applied" | "ignored" | "stale" {
    const view = this.#view;
    if (!view) throw new ClientError("offline");
    if (answer.threadId !== view.thread.id) throw new ClientError("protocol");
    if (this.fillRequest !== request) return "ignored";
    if (this.#missedAgentSeq > answer.seq) return "stale";
    // Bodies read before live changes the store has since applied take those changes too.
    const bodies = new Map<string, Item>(
      this.#journal.reconcile(answer, view.seq).map((item) => [item.id, item]),
    );
    for (const id of answer.order) {
      // A live deletion since the read stands; anything else the answer names is held or sent.
      if (this.#deleted.has(id)) continue;
      const seq = answer.itemSeqs[id] ?? this.#creation.get(id);
      if (seq === undefined || (!bodies.has(id) && !this.item(id))) return "stale";
    }
    const keys = new Set<ThreadKey>(["order", "history", "agents"]);
    const items: Record<string, Item> = {};
    const creation = new Map<string, number>();
    const keep = (id: string, item: Item, seq: number) => {
      Object.defineProperty(items, id, {
        value: item,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      creation.set(id, seq);
    };
    for (const id of answer.order) {
      if (this.#deleted.has(id)) continue;
      const body = bodies.get(id) ?? this.item(id);
      const seq = answer.itemSeqs[id] ?? this.#creation.get(id);
      if (!body || seq === undefined) continue;
      keep(id, body, seq);
      if (bodies.has(id)) this.#hydrated.set(id, Math.max(answer.seq, view.seq));
    }
    // Created live after the answer was read: not in it, and still the window's.
    for (const id of view.itemOrder) {
      const seq = this.#creation.get(id);
      const item = this.item(id);
      if (!Object.hasOwn(items, id) && item && seq !== undefined && seq > answer.seq)
        keep(id, item, seq);
    }
    for (const id of view.itemOrder)
      if (!Object.hasOwn(items, id)) {
        keys.add(`item:${id}`);
        this.#clipped.delete(id);
        this.#hydrated.delete(id);
      }
    for (const id of bodies.keys()) {
      keys.add(`item:${id}`);
      // A preview's whole body has landed: it is cut again only if it is over this client's limits.
      this.#clipped.delete(id);
    }
    view.items = items;
    view.itemOrder = [...creation.keys()].toSorted(
      (a, b) => (creation.get(a) ?? 0) - (creation.get(b) ?? 0),
    );
    this.#creation = creation;
    view.itemsBefore = answer.itemsBefore;
    const agents: ThreadView["agents"] = {};
    const own = new Set(answer.agentIds);
    for (const [id, seq] of this.#agentsCreated) if (seq > answer.seq) own.add(id);
    for (const id of own) {
      const agent =
        this.agent(id) ?? (Object.hasOwn(answer.agents, id) ? answer.agents[id] : undefined);
      if (!agent) continue;
      Object.defineProperty(agents, id, {
        value: agent,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      keys.add(`agent:${id}`);
    }
    for (const id of Object.keys(view.agents)) if (!own.has(id)) keys.add(`agent:${id}`);
    view.agents = agents;
    rebuildAgentChildren(view);
    this.#counts.set("agents", Object.keys(agents).length);
    delete view.fill;
    for (const id of view.itemOrder) this.#clip(id);
    for (const id of this.#trim()) keys.add(`item:${id}`);
    this.#notifications.emit(keys);
    return "applied";
  }
  /** Bound the window, keeping the root agent's share of it (ADR 0062). */
  #trim(): string[] {
    const view = this.#view;
    if (!view || view.itemOrder.length <= this.#limits.items) return [];
    const root = view.thread.rootAgentId;
    const tail = retainedTail(
      view.itemOrder.map((id) => ({
        id,
        seq: this.#creation.get(id),
        root: inRootLane(this.item(id)?.agentId, root),
      })),
      this.#limits.items,
    );
    view.itemOrder = tail.kept.map((entry) => entry.id);
    if (tail.evicted.length) this.#trimmed = true;
    // Everything from the evicted boundary on is held; the cursor never moves back over a hole.
    if (tail.before !== undefined)
      view.itemsBefore =
        typeof view.itemsBefore === "number"
          ? Math.max(view.itemsBefore, tail.before)
          : tail.before;
    const removed = tail.evicted.map((entry) => entry.id);
    for (const id of removed) {
      delete view.items[id];
      this.#clipped.delete(id);
      this.#hydrated.delete(id);
      this.#creation.delete(id);
    }
    return removed;
  }
  #clip(id: string): void {
    const item = this.item(id);
    if (item && clipItem(item, this.#limits)) this.#clipped.add(id);
  }
}
