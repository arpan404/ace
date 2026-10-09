import { applyDelivery } from "@ace/projection";
import type { ClientMessage, ServerMessage, ThreadListView, ThreadListEntry } from "@ace/protocol";
import type { Mirrorable, SidebarExport, SidebarSource } from "./api.ts";
import type { SidebarKey, SidebarReader } from "./readers.ts";
import { Notifications, type ChangeTap, type Selection } from "./observable.ts";
import { ClientError, type Limits } from "./types.ts";

export type { SidebarReader } from "./readers.ts";

export class Sidebar implements SidebarSource, Mirrorable<SidebarExport> {
  private failure: ClientError | undefined;
  get error() {
    return this.failure;
  }
  reject(id: string, error: ClientError): void {
    if (id !== this.wire && id !== this.archiveWire) return;
    this.failure = error;
    if (id === this.archiveWire) this.archiveWire = undefined;
    else this.wire = undefined;
    this.notifications.emit(["error"]);
  }
  private view: ThreadListView | undefined;
  private home: ThreadListView | undefined;
  private archive: ThreadListView | undefined;
  private archiveWire: string | undefined;
  private filter: { project?: string | undefined; archived?: boolean | undefined } = {};
  get homeWindow() {
    return this.home?.window;
  }
  get window() {
    return this.filter.archived ? this.archive?.window : this.home?.window;
  }
  private merge(): void {
    if (!this.home) {
      this.view = undefined;
      this.order = [];
      return;
    }
    this.view = {
      ...this.home,
      threads: { ...this.home.threads, ...this.archive?.threads },
      ...(this.window ? { window: this.window } : {}),
    };
    this.order = Object.keys(this.view.threads);
  }
  configure(input: { project?: string | undefined; archived?: boolean | undefined }): void {
    if (input.project === this.filter.project && !!input.archived === !!this.filter.archived)
      return;
    const projectChanged = input.project !== this.filter.project;
    this.filter = { ...input };
    if (this.archiveWire) this.send({ type: "unsubscribe", subscriptionId: this.archiveWire });
    this.archiveWire = undefined;
    this.archive = undefined;
    if (projectChanged) {
      if (this.wire) this.send({ type: "unsubscribe", subscriptionId: this.wire });
      this.wire = undefined;
      this.home = undefined;
      if (this.refs && this.ready()) this.subscribe();
    } else if (input.archived && this.refs && this.ready()) this.subscribeArchive();
    this.merge();
    this.notifications.emitAll();
  }
  pageRequest() {
    const wire = this.filter.archived ? this.archiveWire : this.wire;
    if (!wire || !this.window?.before) return undefined;
    return { type: "threads.page" as const, subscriptionId: wire, before: this.window.before };
  }
  private order: readonly string[] = [];
  private notifications: Notifications;
  private limits: Limits;
  private send: (message: ClientMessage) => boolean;
  private id: () => string;
  private ready: () => boolean;
  private wire: string | undefined;
  private refs = 0;
  private homeSnapshotAllowed = true;
  private archiveSnapshotAllowed = true;
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
  get loaded(): boolean {
    return this.filter.archived ? this.archive !== undefined : this.home !== undefined;
  }
  thread(id: string): ThreadListEntry | undefined {
    return this.view && Object.hasOwn(this.view.threads, id) ? this.view.threads[id] : undefined;
  }
  select<T>(
    keys: readonly SidebarKey[],
    read: (sidebar: SidebarReader) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    return this.notifications.select(keys, () => read(this), equal);
  }
  observe(tap: ChangeTap): () => void {
    return this.notifications.tap(tap);
  }
  export(): SidebarExport {
    const failure = this.failure;
    return {
      error: failure && { code: failure.code, message: failure.message },
      view: this.view,
      homeWindow: this.home?.window,
      loaded: this.loaded,
      ids: this.order,
    };
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
          if (this.archiveWire)
            this.send({ type: "unsubscribe", subscriptionId: this.archiveWire });
          this.archiveWire = undefined;
        }
      },
    };
  }
  private subscribe(): void {
    this.homeSnapshotAllowed = true;
    this.wire = this.id();
    this.send({
      type: "subscribe",
      subscriptionId: this.wire,
      scope: {
        kind: "threads",
        window: { limit: 20, ...(this.filter.project ? { project: this.filter.project } : {}) },
      },
      ...(this.view ? { afterSeq: this.view.seq } : {}),
    });
    if (this.filter.archived) this.subscribeArchive();
  }
  private subscribeArchive(): void {
    this.archiveSnapshotAllowed = true;
    this.archiveWire = this.id();
    this.send({
      type: "subscribe",
      subscriptionId: this.archiveWire,
      scope: {
        kind: "threads",
        window: {
          limit: 20,
          archived: true,
          ...(this.filter.project ? { project: this.filter.project } : {}),
        },
      },
    });
  }
  reconnect(): void {
    if (this.refs) this.subscribe();
  }
  disconnect(): void {
    this.wire = undefined;
    this.archiveWire = undefined;
  }
  receive(message: ServerMessage): void {
    if (
      (message.type !== "snapshot" &&
        message.type !== "threads.patch" &&
        message.type !== "events" &&
        message.type !== "progress") ||
      (message.subscriptionId !== this.wire && message.subscriptionId !== this.archiveWire)
    )
      return;
    if (message.type === "threads.patch") {
      const previous = message.subscriptionId === this.archiveWire ? this.archive : this.home;
      if (!previous || message.seq < previous.seq) return;
      const threads = { ...previous.threads, ...message.threads };
      for (const id of message.removed) delete threads[id];
      const ids = Object.keys(threads);
      if (ids.length > this.limits.entities) {
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      const next = { ...previous, seq: message.seq, threads, window: message.window };
      if (message.subscriptionId === this.archiveWire) this.archive = next;
      else this.home = next;
      this.merge();
      this.notifications.emit([
        "ids",
        "threads",
        "window",
        "homeWindow",
        ...Object.keys(message.threads).map((id) => `thread:${id}`),
        ...message.removed.map((id) => `thread:${id}`),
      ]);
      return;
    }
    if (message.type === "snapshot") {
      if (message.view.kind !== "threads") throw new ClientError("protocol");
      const archived = message.subscriptionId === this.archiveWire;
      if (!(archived ? this.archiveSnapshotAllowed : this.homeSnapshotAllowed)) return;
      const previous = archived ? this.archive : this.home;
      if (previous && message.seq < previous.seq) return;
      if (archived) this.archiveSnapshotAllowed = false;
      else this.homeSnapshotAllowed = false;
      const ids = Object.keys(message.view.threads);
      if (ids.length > this.limits.entities) {
        this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      this.failure = undefined;
      if (message.subscriptionId === this.archiveWire) this.archive = message.view;
      else this.home = message.view;
      this.merge();
      this.notifications.emitAll();
      return;
    }
    if (message.subscriptionId === this.archiveWire) this.archiveSnapshotAllowed = false;
    else this.homeSnapshotAllowed = false;
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
    // A deleted thread leaves the view; it leaves the order too, so the list never fills up
    // with threads that are gone.
    const removed = [...changed].filter((id) => !Object.hasOwn(view.threads, id));
    if (added.length || removed.length) {
      const gone = new Set(removed);
      this.order = [...this.order, ...added].filter((id) => !gone.has(id));
      keys.push("ids");
    }
    if (keys.length) keys.push("threads");
    this.notifications.emit(keys);
  }
  private resync(): void {
    if (this.wire) this.send({ type: "unsubscribe", subscriptionId: this.wire });
    if (this.archiveWire) this.send({ type: "unsubscribe", subscriptionId: this.archiveWire });
    this.subscribe();
  }
}
