import { applyDelivery } from "@ace/projection";
import type { ThreadView, EventBatch, Progress, Item } from "@ace/protocol";
import { Notifications, type Selection } from "./observable.ts";
import { ClientError, type Limits } from "./types.ts";

export type ThreadKey =
  | "thread"
  | "order"
  | "cursor"
  | "history"
  | `item:${string}`
  | `agent:${string}`
  | `run:${string}`
  | `interaction:${string}`
  | `task:${string}`
  | `usage:${string}`;
export interface ThreadReader {
  readonly thread: ThreadView["thread"] | undefined;
  readonly order: readonly string[];
  readonly cursor: number | undefined;
  readonly itemsBefore: string | null | undefined;
  item(id: string): Item | undefined;
  agent(id: string): ThreadView["agents"][string] | undefined;
  run(id: string): ThreadView["runs"][string] | undefined;
  interaction(id: string): ThreadView["interactions"][string] | undefined;
  task(id: string): ThreadView["backgroundTasks"][string] | undefined;
  usage(id: string): ThreadView["usage"][string] | undefined;
  truncated(id: string): boolean;
}
const emptyOrder: readonly string[] = [];
export class ThreadStore implements ThreadReader {
  private view: ThreadView | undefined;
  private notifications: Notifications;
  private limits: Limits;
  private clipped = new Set<string>();
  private counts = new Map<string, number>();
  constructor(limits: Limits) {
    this.limits = limits;
    this.notifications = new Notifications(limits.listeners);
  }
  get thread() {
    return this.view?.thread;
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
  usage(id: string) {
    return this.own(this.view?.usage, id);
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
    this.view = view;
    this.clipped.clear();
    this.counts.clear();
    // Entity collections must stay bounded without discarding tree status facts.
    for (const [name, record] of Object.entries({
      agents: view.agents,
      runs: view.runs,
      interactions: view.interactions,
      tasks: view.backgroundTasks,
      usage: view.usage,
    })) {
      const size = Object.keys(record).length;
      if (size > this.limits.entities) throw new ClientError("limit", "Entity capacity exceeded");
      this.counts.set(name, size);
    }
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
    const keys = new Set<ThreadKey>(["cursor"]);
    const changedItems = new Set<string>();
    for (const event of message.type === "events" ? message.events : []) {
      const p = event.payload;
      switch (p.type) {
        case "thread.created":
        case "thread.updated":
          view.thread = { ...view.thread };
          keys.add("thread");
          break;
        case "agent.created":
          this.capacity("agents", !!this.agent(p.agent.id));
          if (p.agent.origin === "root") {
            view.thread = { ...view.thread };
            keys.add("thread");
          }
          keys.add(`agent:${p.agent.id}`);
          break;
        case "agent.status":
        case "agent.updated":
          this.copy(view.agents, p.agentId);
          keys.add(`agent:${p.agentId}`);
          break;
        case "run.started":
          this.capacity("runs", !!this.run(p.run.id));
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
          changedItems.add(p.item.id);
          keys.add(`item:${p.item.id}`);
          break;
        case "item.delta":
          {
            const item = this.item(p.itemId);
            if (item?.type === "message")
              view.items[p.itemId] = { ...item, parts: item.parts.map((part) => ({ ...part })) };
            else if (item?.type === "tool_call")
              view.items[p.itemId] = {
                ...item,
                call: { ...item.call, detail: { ...item.call.detail } },
              };
            else if (item) view.items[p.itemId] = { ...item };
          }
          changedItems.add(p.itemId);
          keys.add(`item:${p.itemId}`);
          break;
        case "interaction.opened":
          this.capacity("interactions", !!this.interaction(p.interaction.id));
          keys.add(`interaction:${p.interaction.id}`);
          break;
        case "interaction.closed":
          this.copy(view.interactions, p.interactionId);
          keys.add(`interaction:${p.interactionId}`);
          break;
        case "background_task.started":
          this.capacity("tasks", !!this.task(p.task.id));
          keys.add(`task:${p.task.id}`);
          break;
        case "background_task.updated":
          this.copy(view.backgroundTasks, p.taskId);
          keys.add(`task:${p.taskId}`);
          break;
        case "usage.updated":
          this.capacity("usage", !!this.usage(p.agentId));
          keys.add(`usage:${p.agentId}`);
          break;
      }
    }
    // Authoritative updates for items outside the loaded window must not reinsert history.
    const filtered =
      message.type === "events"
        ? message.events.filter(
            (event) =>
              event.payload.type !== "item.updated" || changedItems.has(event.payload.item.id),
          )
        : undefined;
    const result = applyDelivery(
      view,
      filtered && message.type === "events" ? { ...message, events: filtered } : message,
    );
    if (result.kind !== "applied") return result.kind;
    for (const id of changedItems) this.clip(id);
    const evicted = this.trim();
    if (evicted.length) {
      keys.add("order");
      keys.add("history");
      for (const id of evicted) keys.add(`item:${id}`);
    }
    this.notifications.emit(keys);
    return "applied";
  }
  page(items: Item[], before: string | null): void {
    const view = this.view;
    if (!view) throw new ClientError("offline");
    const keys = new Set<ThreadKey>(["order", "history"]);
    const added: string[] = [];
    for (const item of items)
      if (!this.item(item.id)) {
        view.items[item.id] = item;
        added.push(item.id);
        keys.add(`item:${item.id}`);
        this.clip(item.id);
      }
    view.itemOrder = [...added, ...view.itemOrder];
    view.itemsBefore = before;
    // History scrolling replaces the tail of the bounded window, never grows it.
    while (view.itemOrder.length > this.limits.items) {
      const id = view.itemOrder.pop();
      if (id) {
        delete view.items[id];
        this.clipped.delete(id);
        keys.add(`item:${id}`);
      }
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
    view.itemsBefore = view.itemOrder[0] ?? null;
    for (const id of removed) {
      delete view.items[id];
      this.clipped.delete(id);
    }
    return removed;
  }
  private clip(id: string): void {
    const item = this.item(id);
    if (!item) return;
    const cut = (text: string) => {
      if (text.length <= this.limits.text) return text;
      this.clipped.add(id);
      return text.slice(-Math.max(1, Math.floor(this.limits.text / 2)));
    };
    if (item.type === "message") {
      if (item.parts.length > this.limits.items) {
        item.parts = item.parts.slice(-this.limits.items);
        this.clipped.add(id);
      }
      const first = item.parts[0];
      if (item.parts.length === 1 && first?.type === "text") {
        first.text = cut(first.text);
        return;
      }
      let remaining = this.limits.text;
      for (let i = item.parts.length - 1; i >= 0; i--) {
        const part = item.parts[i];
        if (part?.type === "text") {
          if (part.text.length > remaining) {
            this.clipped.add(id);
            part.text = remaining ? part.text.slice(-remaining) : "";
          }
          remaining -= part.text.length;
        }
      }
    } else if (item.type === "reasoning" || item.type === "notice") item.text = cut(item.text);
    else if (item.type === "tool_call" && item.call.detail.kind === "shell")
      item.call.detail.output = cut(item.call.detail.output ?? "");
  }
}
