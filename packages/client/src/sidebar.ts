import { applyDelivery } from "@ace/projection";
import type { ClientMessage, ServerMessage, ThreadListView, ThreadListEntry } from "@ace/protocol";
import type { Mirrorable, SidebarExport, SidebarSource } from "./api.ts";
import type { SidebarKey, SidebarReader } from "./readers.ts";
import { Notifications, type ChangeTap, type Selection } from "./observable.ts";
import { parseSidebarRecord, sidebarRecord, type SidebarHalf } from "./read-records.ts";
import { SnapshotBinding, contentChanges, type Persistence } from "./read-snapshots.ts";
import { ClientError, type Limits } from "./types.ts";

export type { SidebarReader } from "./readers.ts";

export class Sidebar implements SidebarSource, Mirrorable<SidebarExport> {
  #failure: ClientError | undefined;
  get error() {
    return this.#failure;
  }
  #persistence: Persistence | undefined;
  #binding: SnapshotBinding | undefined;
  #checkpoints = new Set<Promise<void>>();
  /**
   * What the list still waits for before it is the daemon's: each subscription's snapshot, or
   * a reason it has none (restored from disk, released, disconnected). Empty when live.
   */
  #pending = new Set<string>();
  get syncing(): boolean {
    return this.#pending.size > 0;
  }
  /** Halves held from a copy the daemon has not confirmed (from disk, or kept unfollowed). */
  #unconfirmed = new Set<SidebarHalf>();
  get unconfirmed(): boolean {
    return this.#unconfirmed.size > 0;
  }
  #confirm(halves: readonly SidebarHalf[], unconfirmed: boolean): boolean {
    const was = this.unconfirmed;
    for (const half of halves)
      if (unconfirmed) this.#unconfirmed.add(half);
      else this.#unconfirmed.delete(half);
    return was !== this.unconfirmed;
  }
  #await(reasons: readonly string[]): void {
    const was = this.syncing;
    this.#pending.clear();
    for (const reason of reasons) this.#pending.add(reason);
    if (was !== this.syncing) this.#notifications.emit(["sync"]);
  }
  /** Follow the read snapshot of the half the current filter shows, under its own key. */
  #persist(): void {
    this.#retire();
    const persistence = this.#persistence;
    if (!persistence) return;
    const half = this.#filter.archived ? "archive" : "home";
    this.#binding = new SnapshotBinding(
      persistence,
      `sidebar:${JSON.stringify([this.#filter.project ?? null, !!this.#filter.archived])}`,
      contentChanges((tap) => this.observe(tap)),
      () => sidebarRecord(half, half === "archive" ? this.#archive : this.#home),
      (value) => this.#restore(value),
    );
  }
  #retire(): void {
    const written = this.#binding?.close();
    this.#binding = undefined;
    if (!written) return;
    this.#checkpoints.add(written);
    void written.finally(() => this.#checkpoints.delete(written));
  }
  /**
   * Paint a half read back from disk until its subscription's snapshot arrives. A half is
   * adopted only where none is held; one that does not parse or is over the entity limit is
   * skipped without blocking the other.
   */
  #restore(value: unknown): void {
    const record = parseSidebarRecord(value);
    const fits = (view: ThreadListView | undefined): view is ThreadListView =>
      view !== undefined && Object.keys(view.threads).length <= this.#limits.entities;
    const home = !this.#home && fits(record.home) ? record.home : undefined;
    const archive = !this.#archive && fits(record.archive) ? record.archive : undefined;
    if (!home && !archive) return;
    if (home) this.#home = home;
    if (archive) this.#archive = archive;
    this.#confirm(
      [...(home ? ["home" as const] : []), ...(archive ? ["archive" as const] : [])],
      true,
    );
    if (!this.#pending.size) this.#pending.add("restored");
    this.#merge();
    this.#notifications.emitAll();
  }
  /** Checkpoint the read snapshot; resolves once it, and earlier ones, are written. */
  close(): Promise<void> {
    this.#retire();
    return Promise.all(this.#checkpoints).then(() => {});
  }
  reject(id: string, error: ClientError): void {
    if (id !== this.#wire && id !== this.#archiveWire) return;
    this.#failure = error;
    this.#pending.delete(id);
    if (id === this.#archiveWire) this.#archiveWire = undefined;
    else this.#wire = undefined;
    this.#notifications.emit(["error", "sync"]);
  }
  #view: ThreadListView | undefined;
  #home: ThreadListView | undefined;
  #archive: ThreadListView | undefined;
  #archiveWire: string | undefined;
  #filter: { project?: string | undefined; archived?: boolean | undefined } = {};
  get homeWindow() {
    return this.#home?.window;
  }
  get window() {
    return this.#filter.archived ? this.#archive?.window : this.#home?.window;
  }
  #merge(): void {
    // Either half paints before the other arrives: a list restored at the archive shows its
    // rows at once. Screens filter rows by archived state, so home rows never show there.
    const base = this.#home ?? this.#archive;
    if (!base) {
      this.#view = undefined;
      this.#order = [];
      return;
    }
    this.#view = {
      ...base,
      threads: { ...this.#home?.threads, ...this.#archive?.threads },
      ...(this.window ? { window: this.window } : {}),
    };
    this.#order = Object.keys(this.#view.threads);
  }
  configure(input: { project?: string | undefined; archived?: boolean | undefined }): void {
    if (input.project === this.#filter.project && !!input.archived === !!this.#filter.archived)
      return;
    this.#retire();
    const projectChanged = input.project !== this.#filter.project;
    this.#filter = { ...input };
    if (projectChanged) this.#pending.clear();
    else if (this.#archiveWire) this.#pending.delete(this.#archiveWire);
    if (this.#archiveWire) this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
    this.#archiveWire = undefined;
    this.#archive = undefined;
    this.#confirm(["archive"], false);
    if (projectChanged) {
      if (this.#wire) this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
      this.#wire = undefined;
      this.#home = undefined;
      this.#confirm(["home"], false);
      if (this.#refs && this.#ready()) this.#subscribe();
    } else if (input.archived && this.#refs && this.#ready()) this.#subscribeArchive();
    this.#merge();
    this.#notifications.emitAll();
    this.#persist();
  }
  pageRequest() {
    const wire = this.#filter.archived ? this.#archiveWire : this.#wire;
    if (!wire || !this.window?.before) return undefined;
    return { type: "threads.page" as const, subscriptionId: wire, before: this.window.before };
  }
  #order: readonly string[] = [];
  #notifications: Notifications;
  #limits: Limits;
  #send: (message: ClientMessage) => boolean;
  #id: () => string;
  #ready: () => boolean;
  #wire: string | undefined;
  #refs = 0;
  #homeSnapshotAllowed = true;
  #archiveSnapshotAllowed = true;
  constructor(
    limits: Limits,
    send: (message: ClientMessage) => boolean,
    id: () => string,
    ready: () => boolean,
    persistence?: Persistence,
  ) {
    this.#persistence = persistence;
    this.#limits = limits;
    this.#send = send;
    this.#id = id;
    this.#ready = ready;
    this.#notifications = new Notifications(limits.listeners);
    this.#persist();
  }
  get ids(): readonly string[] {
    return this.#order;
  }
  get loaded(): boolean {
    return this.#filter.archived ? this.#archive !== undefined : this.#home !== undefined;
  }
  thread(id: string): ThreadListEntry | undefined {
    return this.#view && Object.hasOwn(this.#view.threads, id) ? this.#view.threads[id] : undefined;
  }
  select<T>(
    keys: readonly SidebarKey[],
    read: (sidebar: SidebarReader) => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    return this.#notifications.select(keys, () => read(this), equal);
  }
  observe(tap: ChangeTap): () => void {
    return this.#notifications.tap(tap);
  }
  export(): SidebarExport {
    const failure = this.#failure;
    return {
      ...(this.syncing ? { syncing: true } : {}),
      ...(this.unconfirmed ? { unconfirmed: true } : {}),
      error: failure && { code: failure.code, message: failure.message },
      view: this.#view,
      homeWindow: this.#home?.window,
      loaded: this.loaded,
      ids: this.#order,
    };
  }
  acquire(): { store: Sidebar; release(): void } {
    if (this.#refs++ === 0 && this.#ready()) this.#subscribe();
    let released = false;
    return {
      store: this,
      release: () => {
        if (released) return;
        released = true;
        if (--this.#refs === 0 && this.#wire) {
          this.#await(["released"]);
          // Kept unfollowed: what a warm view paints from it is no longer confirmed.
          const held = [
            ...(this.#home ? ["home" as const] : []),
            ...(this.#archive ? ["archive" as const] : []),
          ];
          if (this.#confirm(held, true)) this.#notifications.emit(["unconfirmed"]);
          this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
          this.#wire = undefined;
          if (this.#archiveWire)
            this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
          this.#archiveWire = undefined;
        }
      },
    };
  }
  #subscribe(): void {
    this.#homeSnapshotAllowed = true;
    this.#wire = this.#id();
    this.#await([this.#wire]);
    this.#send({
      type: "subscribe",
      subscriptionId: this.#wire,
      scope: {
        kind: "threads",
        window: { limit: 20, ...(this.#filter.project ? { project: this.#filter.project } : {}) },
      },
      // No cursor: a windowed list always starts from a fresh window.
    });
    if (this.#filter.archived) this.#subscribeArchive();
  }
  #subscribeArchive(): void {
    this.#archiveSnapshotAllowed = true;
    this.#archiveWire = this.#id();
    if (!this.#pending.size) this.#notifications.emit(["sync"]);
    this.#pending.add(this.#archiveWire);
    this.#send({
      type: "subscribe",
      subscriptionId: this.#archiveWire,
      scope: {
        kind: "threads",
        window: {
          limit: 20,
          archived: true,
          ...(this.#filter.project ? { project: this.#filter.project } : {}),
        },
      },
    });
  }
  reconnect(): void {
    if (this.#refs) this.#subscribe();
  }
  disconnect(): void {
    if (this.#refs) this.#await(["disconnected"]);
    this.#wire = undefined;
    this.#archiveWire = undefined;
  }
  receive(message: ServerMessage): void {
    if (
      (message.type !== "snapshot" &&
        message.type !== "threads.patch" &&
        message.type !== "events" &&
        message.type !== "progress") ||
      (message.subscriptionId !== this.#wire && message.subscriptionId !== this.#archiveWire)
    )
      return;
    if (message.type === "threads.patch") {
      const previous = message.subscriptionId === this.#archiveWire ? this.#archive : this.#home;
      if (!previous || message.seq < previous.seq) return;
      const threads = { ...previous.threads, ...message.threads };
      for (const id of message.removed) delete threads[id];
      const ids = Object.keys(threads);
      if (ids.length > this.#limits.entities) {
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      const next = { ...previous, seq: message.seq, threads, window: message.window };
      if (message.subscriptionId === this.#archiveWire) this.#archive = next;
      else this.#home = next;
      this.#merge();
      this.#notifications.emit([
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
      const archived = message.subscriptionId === this.#archiveWire;
      // A subscription's one snapshot is authoritative even below what is held: that may be a
      // disk copy, or a tail a crashed daemon lost. Wire ids fence older subscriptions' frames.
      if (!(archived ? this.#archiveSnapshotAllowed : this.#homeSnapshotAllowed)) return;
      if (archived) this.#archiveSnapshotAllowed = false;
      else this.#homeSnapshotAllowed = false;
      const ids = Object.keys(message.view.threads);
      if (ids.length > this.#limits.entities) {
        this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      this.#failure = undefined;
      if (message.subscriptionId === this.#archiveWire) this.#archive = message.view;
      else this.#home = message.view;
      this.#confirm([message.subscriptionId === this.#archiveWire ? "archive" : "home"], false);
      this.#pending.delete(message.subscriptionId);
      this.#merge();
      this.#notifications.emitAll();
      return;
    }
    if (message.subscriptionId === this.#archiveWire) this.#archiveSnapshotAllowed = false;
    else this.#homeSnapshotAllowed = false;
    const view = this.#view;
    if (view && message.throughSeq <= view.seq) return;
    if (!view || message.afterSeq !== view.seq) {
      this.#resync();
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
    if (this.#order.length + added.length > this.#limits.entities) {
      this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
      this.reject(message.subscriptionId, new ClientError("limit"));
      return;
    }
    if (applyDelivery(view, message).kind === "gap") {
      this.#resync();
      return;
    }
    const keys = [...changed].map((id) => `thread:${id}`);
    // A deleted thread leaves the view; it leaves the order too, so the list never fills up
    // with threads that are gone.
    const removed = [...changed].filter((id) => !Object.hasOwn(view.threads, id));
    if (added.length || removed.length) {
      const gone = new Set(removed);
      this.#order = [...this.#order, ...added].filter((id) => !gone.has(id));
      keys.push("ids");
    }
    if (keys.length) keys.push("threads");
    this.#notifications.emit(keys);
  }
  #resync(): void {
    if (this.#wire) this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
    if (this.#archiveWire) this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
    this.#subscribe();
  }
}
