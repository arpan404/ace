import { applyDelivery } from "@ace/projection";
import type { ClientMessage, ServerMessage, ThreadListView, ThreadListEntry } from "@ace/protocol";
import { Notifications, type Selection } from "./observable.ts";
import { ClientError, type Limits } from "./types.ts";

export interface SidebarReader {
  readonly error: ClientError | undefined;
  readonly ids: readonly string[];
  thread(id: string): ThreadListEntry | undefined;
}
export class Sidebar implements SidebarReader {
  private failure: ClientError | undefined;
  get error() {
    return this.failure;
  }
  reject(id: string, error: ClientError): void {
    if (id !== this.wire) return;
    this.failure = error;
    this.wire = undefined;
    this.notifications.emit(["error"]);
  }
  private view: ThreadListView | undefined;
  private order: readonly string[] = [];
  private notifications: Notifications;
  private limits: Limits;
  private send: (message: ClientMessage) => boolean;
  private id: () => string;
  private ready: () => boolean;
  private wire: string | undefined;
  private refs = 0;
  private snapshotAllowed = true;
  constructor(
    limits: Limits,
    send: (message: ClientMessage) => boolean,
    id: () => string,
    ready: () => boolean,
  ) {
    this.limits = limits;
    this.send = send;
    this.id = id;
    this.ready = ready;
    this.notifications = new Notifications(limits.listeners);
  }
  get ids(): readonly string[] {
    return this.order;
  }
  thread(id: string): ThreadListEntry | undefined {
    return this.view && Object.hasOwn(this.view.threads, id) ? this.view.threads[id] : undefined;
  }
  select<T>(
    keys: readonly ("error" | "ids" | `thread:${string}`)[],
    read: (sidebar: SidebarReader) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    return this.notifications.select(keys, () => read(this), equal);
  }
  acquire(): { store: Sidebar; release(): void } {
    if (this.refs++ === 0 && this.ready()) this.subscribe();
    let released = false;
    return {
      store: this,
      release: () => {
        if (released) return;
        released = true;
        if (--this.refs === 0 && this.wire) {
          this.send({ type: "unsubscribe", subscriptionId: this.wire });
          this.wire = undefined;
        }
      },
    };
  }
  private subscribe(): void {
    this.snapshotAllowed = true;
    this.wire = this.id();
    this.send({
      type: "subscribe",
      subscriptionId: this.wire,
      scope: { kind: "threads" },
      ...(this.view ? { afterSeq: this.view.seq } : {}),
    });
  }
  reconnect(): void {
    if (this.refs) this.subscribe();
  }
  disconnect(): void {
    this.wire = undefined;
  }
  receive(message: ServerMessage): void {
    if (
      (message.type !== "snapshot" && message.type !== "events" && message.type !== "progress") ||
      message.subscriptionId !== this.wire
    )
      return;
    if (message.type === "snapshot") {
      if (message.view.kind !== "threads") throw new ClientError("protocol");
      if (!this.snapshotAllowed || (this.view && message.seq < this.view.seq)) return;
      this.snapshotAllowed = false;
      const ids = Object.keys(message.view.threads);
      if (ids.length > this.limits.entities) {
        this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      this.failure = undefined;
      this.view = message.view;
      this.order = ids;
      this.notifications.emitAll();
      return;
    }
    this.snapshotAllowed = false;
    const view = this.view;
    if (view && message.throughSeq <= view.seq) return;
    if (!view || message.afterSeq !== view.seq) {
      this.resync();
      return;
    }
    const changed = new Set<string>();
    const added: string[] = [];
    for (const event of message.type === "events" ? message.events : []) {
      const entry = this.thread(event.threadId);
      if (event.payload.type === "thread.created" && !entry && !changed.has(event.threadId))
        added.push(event.threadId);
      if (entry) view.threads[event.threadId] = { ...entry };
      changed.add(event.threadId);
    }
    if (this.order.length + added.length > this.limits.entities) {
      this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
      this.reject(message.subscriptionId, new ClientError("limit"));
      return;
    }
    if (applyDelivery(view, message).kind === "gap") {
      this.resync();
      return;
    }
    const keys = [...changed].map((id) => `thread:${id}`);
    if (added.length) {
      this.order = [...this.order, ...added];
      keys.push("ids");
    }
    this.notifications.emit(keys);
  }
  private resync(): void {
    if (this.wire) this.send({ type: "unsubscribe", subscriptionId: this.wire });
    this.snapshotAllowed = true;
    this.wire = this.id();
    this.send({ type: "subscribe", subscriptionId: this.wire, scope: { kind: "threads" } });
  }
}
