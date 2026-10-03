import { clipItem } from "./item-window.ts";
import { pageWindow } from "./page-window.ts";
import { MessageDeltas } from "./message-deltas.ts";
import { PageJournal } from "./page-journal.ts";
import { applyDelivery, usageSnapshotKey } from "@ace/projection";
import type { ThreadView, EventBatch, Progress, Item, ItemsPage } from "@ace/protocol";
import { Notifications, type Selection } from "./observable.ts";
import { ClientError, type Limits } from "./types.ts";

export type ThreadKey =
  | "error"
  | "thread"
  | "queue"
  | "order"
  | "cursor"
  | "history"
  | "agents"
  | "interactions"
  | "tasks"
  | `item:${string}`
  | `agent:${string}`
  | `run:${string}`
  | `interaction:${string}`
  | `task:${string}`
  | `context:${string}`
  | `usage:${string}`
  | `usageSnapshot:${string}`;
export interface ThreadReader {
  readonly error: ClientError | undefined;
  readonly thread: ThreadView["thread"] | undefined;
  readonly queue: ThreadView["queue"] | undefined;
  readonly context: import("@ace/protocol").ContextMeter | undefined;
  readonly order: readonly string[];
  readonly cursor: number | undefined;
  readonly itemsBefore: number | null | undefined;
  /** Fresh membership lists: select with the "agents", "interactions" or "tasks" key and
   * an array equality, because each call returns a new array. */
  agentIds(): readonly string[];
  children(agentId: string): readonly string[];
  interactionIds(): readonly string[];
  taskIds(): readonly string[];
  item(id: string): Item | undefined;
  agent(id: string): ThreadView["agents"][string] | undefined;
  run(id: string): ThreadView["runs"][string] | undefined;
  interaction(id: string): ThreadView["interactions"][string] | undefined;
  task(id: string): ThreadView["backgroundTasks"][string] | undefined;
  usage(id: string): ThreadView["usage"][string] | undefined;
  contextMeter(id: string): import("@ace/protocol").ContextMeter | undefined;
  usageSnapshot(key: string): ThreadView["usageSnapshots"][string] | undefined;
  truncated(id: string): boolean;
}
const emptyOrder: readonly string[] = [];
export class ThreadStore implements ThreadReader {
  private messageDeltas = new MessageDeltas();
  private journal: PageJournal;
  private hydrated = new Map<string, number>();
  private creation = new Map<string, number>();
  private failure: ClientError | undefined;
  get error() {
    return this.failure;
  }
  fail(error: ClientError): void {
    this.failure = error;
    this.notifications.emit(["error"]);
  }
  private view: ThreadView | undefined;
  private notifications: Notifications;
  private limits: Limits;
  private clipped = new Set<string>();
  private counts = new Map<string, number>();
  constructor(limits: Limits) {
    this.limits = limits;
    this.journal = new PageJournal(limits);
    this.notifications = new Notifications(limits.listeners);
  }
  get thread() {
    return this.view?.thread;
  }
  get queue() {
    return this.view?.queue;
  }
  get context() {
    const root = this.view?.thread.rootAgentId;
    return root ? this.contextMeter(root) : undefined;
  }
  get order(): readonly string[] {
    return this.view?.itemOrder ?? emptyOrder;
  }
  get cursor() {
    return this.view?.seq;
  }
  get itemsBefore() {
    return this.view?.itemsBefore;
  }
  agentIds(): readonly string[] {
    return this.view ? Object.keys(this.view.agents) : emptyOrder;
  }
  children(agentId: string): readonly string[] {
    // Projection appends children in place, so never hand out its array.
    return [...(this.own(this.view?.agentChildren, agentId) ?? emptyOrder)];
  }
  interactionIds(): readonly string[] {
    return this.view ? Object.keys(this.view.interactions) : emptyOrder;
  }
  taskIds(): readonly string[] {
    return this.view ? Object.keys(this.view.backgroundTasks) : emptyOrder;
  }
  item(id: string) {
    return this.own(this.view?.items, id);
  }
  agent(id: string) {
    return this.own(this.view?.agents, id);
  }
  run(id: string) {
    return this.own(this.view?.runs, id);
  }
  interaction(id: string) {
    return this.own(this.view?.interactions, id);
  }
  task(id: string) {
    return this.own(this.view?.backgroundTasks, id);
  }
  contextMeter(id: string) {
    const meters = this.view?.contextMeters;
    return meters && Object.hasOwn(meters, id) ? meters[id] : undefined;
  }
  usage(id: string) {
    return this.own(this.view?.usage, id);
  }
  usageSnapshot(key: string) {
    return this.own(this.view?.usageSnapshots, key);
  }
  truncated(id: string) {
    return this.clipped.has(id);
  }
  private own<T>(record: Record<string, T> | undefined, id: string): T | undefined {
    return record && Object.hasOwn(record, id) ? record[id] : undefined;
  }
  select<T>(
    keys: readonly ThreadKey[],
    selector: (reader: ThreadReader) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    return this.notifications.select(keys, () => selector(this), equal);
  }
  snapshot(view: ThreadView): void {
    if (view.itemOrder.length > 200 || Object.keys(view.items).length > 200)
      throw new ClientError("limit", "Snapshot item capacity exceeded");
    if (Object.keys(view.itemSeqs ?? {}).length > 200)
      throw new ClientError("limit", "Item cursor capacity exceeded");
    const parentKeys = Object.keys(view.agentChildren);
    const parentReferences = Object.values(view.agentChildren).reduce(
      (count, children) => count + children.length,
      0,
    );
    if (parentKeys.length > this.limits.entities || parentReferences > this.limits.entities)
      throw new ClientError("limit", "Parent reference capacity exceeded");
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
    })) {
      const size = Object.keys(record).length;
      if (size > this.limits.entities) throw new ClientError("limit", "Entity capacity exceeded");
      counts.set(name, size);
    }
    this.view = view;
    this.failure = undefined;
    this.journal.reset(view.seq);
    this.hydrated.clear();
    this.creation.clear();
    this.clipped.clear();
    this.counts = counts;
    for (const id of view.itemOrder) {
      const seq = view.itemSeqs?.[id];
      if (seq !== undefined) this.creation.set(id, seq);
    }
    delete view.itemSeqs;
    this.trim();
    for (const id of view.itemOrder) this.clip(id);
    this.notifications.emitAll();
  }
  private copy<T>(record: Record<string, T>, id: string): void {
    const value = this.own(record, id);
    // Entities are individually bounded. No full view or history copy on deltas.
    if (value !== undefined) record[id] = { ...value };
  }
  private capacity(name: string, exists: boolean): void {
    if (exists) return;
    const count = (this.counts.get(name) ?? 0) + 1;
    if (count > this.limits.entities) throw new ClientError("limit", "Entity capacity exceeded");
    this.counts.set(name, count);
  }
  delivery(message: EventBatch | Progress): "applied" | "ignored" | "gap" {
    const view = this.view;
    if (!view) return "gap";
    if (message.throughSeq <= view.seq) return "ignored";
    if (message.afterSeq !== view.seq) return "gap";
    if (message.type === "events")
      for (const event of message.events) {
        if (event.threadId !== view.thread.id) throw new ClientError("protocol");
        this.journal.record(event);
      }
    const admitted = new Set<string>();
    const sequential =
      message.type === "events"
        ? message.events.filter((event) => {
            const payload = event.payload;
            const itemId =
              payload.type === "item.created" || payload.type === "item.updated"
                ? payload.item.id
                : payload.type === "item.delta"
                  ? payload.itemId
                  : undefined;
            if (itemId && event.seq <= (this.hydrated.get(itemId) ?? -1)) return false;
            if (payload.type === "item.created") this.creation.set(payload.item.id, event.seq);
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
          view.thread = { ...view.thread };
          keys.add("thread");
          break;
        case "agent.created":
          if (!keys.has(`agent:${p.agent.id}`)) this.capacity("agents", !!this.agent(p.agent.id));
          if (p.agent.origin === "root") {
            view.thread = { ...view.thread };
            keys.add("thread");
          }
          keys.add(`agent:${p.agent.id}`);
          keys.add("agents");
          break;
        case "agent.status":
        case "agent.updated":
          this.copy(view.agents, p.agentId);
          keys.add(`agent:${p.agentId}`);
          if (p.type === "agent.updated" && p.parentId !== undefined) keys.add("agents");
          break;
        case "run.started":
          if (!keys.has(`run:${p.run.id}`)) this.capacity("runs", !!this.run(p.run.id));
          keys.add(`run:${p.run.id}`);
          break;
        case "run.ended":
          this.copy(view.runs, p.runId);
          keys.add(`run:${p.runId}`);
          break;
        case "item.created":
        case "item.updated":
          if (p.type === "item.updated" && !this.item(p.item.id)) break;
          if (!this.item(p.item.id)) {
            view.itemOrder = [...view.itemOrder];
            keys.add("order");
          }
          keys.add(`item:${p.item.id}`);
          break;
        case "item.delta":
          {
            const item = this.item(p.itemId);
            if (item?.type === "message" && p.field === "text") {
              view.items[p.itemId] = this.messageDeltas.append(
                item,
                p.append,
                this.limits.text,
                this.limits.items,
                () => this.clipped.add(p.itemId),
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
            this.capacity("interactions", !!this.interaction(p.interaction.id));
          keys.add(`interaction:${p.interaction.id}`);
          keys.add("interactions");
          break;
        case "interaction.closed":
          this.copy(view.interactions, p.interactionId);
          keys.add(`interaction:${p.interactionId}`);
          break;
        case "background_task.started":
          if (!keys.has(`task:${p.task.id}`)) this.capacity("tasks", !!this.task(p.task.id));
          keys.add(`task:${p.task.id}`);
          keys.add("tasks");
          break;
        case "background_task.updated":
          this.copy(view.backgroundTasks, p.taskId);
          keys.add(`task:${p.taskId}`);
          break;
        case "queue.updated":
          keys.add("queue");
          break;
        case "context_meter.updated":
          if (!keys.has(`context:${p.meter.agentId}`))
            this.capacity("contextMeters", !!this.contextMeter(p.meter.agentId));
          keys.add(`context:${p.meter.agentId}`);
          break;
        case "usage.updated": {
          if (p.usageScope === "provider_session" || p.usageScope === "model_session") {
            const key = usageSnapshotKey(p);
            if (!keys.has(`usageSnapshot:${key}`))
              this.capacity("usageSnapshots", !!this.usageSnapshot(key));
            keys.add(`usageSnapshot:${key}`);
          } else {
            if (!keys.has(`usage:${p.agentId}`)) this.capacity("usage", !!this.usage(p.agentId));
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
      if (p.type === "item.created" || p.type === "item.updated") this.clip(p.item.id);
      else if (p.type === "item.delta" && !appended) this.clip(p.itemId);
    }
    view.seq = message.throughSeq;
    const evicted = this.trim();
    if (evicted.length) {
      keys.add("order");
      keys.add("history");
      for (const id of evicted) keys.add(`item:${id}`);
    }
    this.notifications.emit(keys);
    return "applied";
  }
  page(page: ItemsPage): void {
    const view = this.view;
    if (!view) throw new ClientError("offline");
    if (page.threadId !== view.thread.id) throw new ClientError("protocol");
    const items = this.journal.reconcile(page, view.seq);
    const window = pageWindow(view.itemOrder, this.creation, page, this.limits.items);
    const retained = new Set(window.order);
    const keys = new Set<ThreadKey>();
    for (const item of items)
      if (retained.has(item.id) && !this.item(item.id)) {
        Object.defineProperty(view.items, item.id, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        this.hydrated.set(item.id, Math.max(page.seq, view.seq));
        const seq = page.itemSeqs?.[item.id];
        if (seq !== undefined) this.creation.set(item.id, seq);
        keys.add(`item:${item.id}`);
        this.clip(item.id);
      }
    for (const id of view.itemOrder)
      if (!retained.has(id)) {
        delete view.items[id];
        this.clipped.delete(id);
        this.hydrated.delete(id);
        this.creation.delete(id);
        keys.add(`item:${id}`);
      }
    if (
      view.itemOrder.length !== window.order.length ||
      view.itemOrder.some((id, index) => id !== window.order[index])
    ) {
      view.itemOrder = window.order;
      keys.add("order");
    }
    // Null means the oldest item was reached. A duplicate response cannot undo that fact.
    const before = view.itemsBefore === null ? null : window.before;
    if (view.itemsBefore !== before) {
      view.itemsBefore = before;
      keys.add("history");
    }
    this.notifications.emit(keys);
  }
  private trim(): string[] {
    const view = this.view;
    if (!view) return [];
    const count = view.itemOrder.length - this.limits.items;
    if (count <= 0) return [];
    const removed = view.itemOrder.slice(0, count);
    view.itemOrder = view.itemOrder.slice(count);
    view.itemsBefore = this.creation.get(view.itemOrder[0] ?? "") ?? view.itemsBefore;
    for (const id of removed) {
      delete view.items[id];
      this.clipped.delete(id);
      this.hydrated.delete(id);
      this.creation.delete(id);
    }
    return removed;
  }
  private clip(id: string): void {
    const item = this.item(id);
    if (item && clipItem(item, this.limits)) this.clipped.add(id);
  }
}
