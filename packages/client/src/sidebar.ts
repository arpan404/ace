import { applyDelivery } from "@ace/projection";
import type {
  ClientMessage,
  ServerMessage,
  ThreadListResume,
  ThreadListView,
  ThreadListEntry,
} from "@ace/protocol";
import type { Mirrorable, SidebarExport, SidebarSource } from "./api.ts";
import type { SidebarKey, SidebarReader } from "./readers.ts";
import { Notifications, type ChangeTap, type Selection } from "./observable.ts";
import { parseSidebarRecord, sidebarRecord, type SidebarHalf } from "./read-records.ts";
import {
  SnapshotBinding,
  contentChanges,
  firstReadMs,
  type Persistence,
} from "./read-snapshots.ts";
import {
  listStartup,
  stepStartup,
  type ListStartup,
  type StartupInput,
} from "./sidebar-startup.ts";
import { FilterMemory, resumeOf, type ProvisionalSource } from "./sidebar-memory.ts";
import { ClientError, type Limits } from "./types.ts";

export type { SidebarReader } from "./readers.ts";

/** What the list waits for while a window's refused subscribe waits to be asked again. */
const refusedReason = (half: SidebarHalf) => `refused:${half}`;
/** The read cursor of a thread the device never marked read. */
const unread = { lastSeenSeq: 0, updatedAt: null };

export class Sidebar implements SidebarSource, Mirrorable<SidebarExport> {
  /**
   * Each window's refusal (Home's, the archive's), until that window's own snapshot lands: one
   * window's answer never clears what the other was refused.
   */
  #refused = new Map<SidebarHalf, ClientError>();
  get error() {
    return this.#refused.get("home") ?? this.#refused.get("archive");
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
    const key = this.#key();
    this.#binding = new SnapshotBinding(
      persistence,
      key,
      contentChanges((tap) => this.observe(tap)),
      // A derived list is part of another filter's: it is never written as this filter's.
      () =>
        this.#provisional.get(half) === "derived"
          ? undefined
          : sidebarRecord(half, half === "archive" ? this.#archive : this.#home),
      (value) => this.#restore(value),
    );
    // While the list starts, its kept list for this filter is what its first subscribe waits
    // for (`sidebar-startup.ts`): the read settling, found or not, is one of its inputs.
    if (this.#startup.phase === "waiting")
      // The read settling, found or not, is an input; a failed read leaves the opening deadline
      // to start the list.
      void this.#binding.read
        .then(() => this.#drive({ type: "read", filter: key }))
        .catch(() => {});
  }
  /** The key the current filter's kept list is stored under. */
  #key(): string {
    return `sidebar:${JSON.stringify([this.#filter.project ?? null, !!this.#filter.archived])}`;
  }
  /** The list's first subscribe, waiting for its kept list (`sidebar-startup.ts`). */
  #startup: ListStartup = { phase: "subscribed" };
  /** Stops the deadline set when the list was first held, before its first subscribe. */
  #deadline: (() => void) | undefined;
  #drive(input: StartupInput): void {
    const step = stepStartup(this.#startup, input);
    this.#startup = step.state;
    if (step.subscribe === undefined) return;
    this.#deadline?.();
    this.#deadline = undefined;
    // For the filter current now: the one the machine subscribed for.
    this.#subscribe();
  }
  #retire(): void {
    const written = this.#binding?.close();
    this.#binding = undefined;
    if (!written) return;
    this.#checkpoints.add(written);
    // A checkpoint that fails writes nothing; the next change writes the newest copy.
    void written.catch(() => {}).finally(() => this.#checkpoints.delete(written));
  }
  /**
   * Paint a half read back from disk until its subscription's snapshot arrives. A half is
   * adopted only where none is held, or where the one held was derived from another filter's
   * list; one that does not parse or is over the entity limit is skipped without blocking the
   * other.
   */
  #restore(value: unknown): void {
    const record = parseSidebarRecord(value);
    const open = (half: SidebarHalf) =>
      !(half === "archive" ? this.#archive : this.#home) ||
      this.#provisional.get(half) === "derived";
    const fits = (view: ThreadListView | undefined): view is ThreadListView =>
      view !== undefined && Object.keys(view.threads).length <= this.#limits.entities;
    const home = open("home") && fits(record.home) ? record.home : undefined;
    const archive = open("archive") && fits(record.archive) ? record.archive : undefined;
    if (!home && !archive) return;
    if (home) this.#home = home;
    if (archive) this.#archive = archive;
    if (home) this.#provisional.delete("home");
    if (archive) this.#provisional.delete("archive");
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
    const half: SidebarHalf = id === this.#archiveWire ? "archive" : "home";
    this.#refused.set(half, error);
    // Refused is not answered: the window still waits, and the rows it holds are a copy the
    // daemon hasn't confirmed, until its own snapshot lands.
    this.#pending.delete(id);
    this.#pending.add(refusedReason(half));
    if (half === "archive") this.#archiveWire = undefined;
    else this.#wire = undefined;
    if (half === "archive" ? this.#archive : this.#home) this.#confirm([half], true);
    this.#notifications.emit(["error", "sync", "unconfirmed"]);
    // A refusal never rests while the list is held, as a thread's doesn't: the daemon may turn
    // a subscribe down for a moment (busy, at its subscription limit). Without asking again the
    // list stays unconfirmed for the rest of the socket. One over this client's own limit
    // fails the same way every time: it rests. Each window backs off on its own.
    if (this.#refs && error.code !== "limit" && !this.#waits.has(half)) {
      const failures = this.#failures.get(half) ?? 0;
      this.#failures.set(half, failures + 1);
      const wait = Math.min(30_000, 500 * 2 ** failures);
      this.#waits.set(
        half,
        this.#delay(wait, () => {
          this.#waits.delete(half);
          this.#askAgain(half);
        }),
      );
    }
  }
  /** The refused window's subscribe, once more on the same socket; the other is left alone. */
  #askAgain(half: SidebarHalf): void {
    if (!this.#refs || !this.#ready() || this.#startup.phase === "waiting") return;
    if (half === "home" && !this.#wire)
      this.#subscribeHome([...this.#pending].filter((reason) => reason !== refusedReason("home")));
    if (half === "archive" && this.#filter.archived && !this.#archiveWire) this.#subscribeArchive();
  }
  /** Stops every wait to ask a refused window again. */
  #cancelRetries(): void {
    for (const cancel of this.#waits.values()) cancel();
    this.#waits.clear();
  }
  /** The archive window is gone: what it was refused or waited for goes with it. */
  #forgetArchive(): void {
    this.#refused.delete("archive");
    this.#pending.delete(refusedReason("archive"));
    this.#waits.get("archive")?.();
    this.#waits.delete("archive");
    this.#failures.delete("archive");
  }
  #view: ThreadListView | undefined;
  #memory = new FilterMemory();
  /** Halves painted from memory until their subscription's snapshot lands. */
  #provisional = new Map<SidebarHalf, ProvisionalSource>();
  /** Where a Home list painted from memory can resume from. */
  #rememberedResume: ThreadListResume | undefined;
  /** The last resume kept ids this list no longer held: the next subscription starts over. */
  #fresh = false;
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
    this.#keep("archive");
    if (projectChanged) this.#keep("home");
    this.#filter = { ...input };
    if (projectChanged) this.#pending.clear();
    else if (this.#archiveWire) this.#pending.delete(this.#archiveWire);
    if (this.#archiveWire) this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
    this.#archiveWire = undefined;
    this.#archive = undefined;
    this.#confirm(["archive"], false);
    this.#forgetArchive();
    if (input.archived) this.#adopt("archive");
    if (projectChanged) {
      if (this.#wire) this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
      this.#wire = undefined;
      this.#home = undefined;
      this.#confirm(["home"], false);
      // Another project's list: what this one was refused, and its wait to ask again, say
      // nothing of it. Its own first refusal starts its own backoff.
      this.#refused.delete("home");
      this.#failures.delete("home");
      this.#waits.get("home")?.();
      this.#waits.delete("home");
      this.#adopt("home");
    }
    // While the list starts, no filter change subscribes: the first subscribe goes for the
    // filter current when it goes (`sidebar-startup.ts`), Home and, if shown, Archive.
    const starting = this.#startup.phase === "waiting";
    if (!starting && projectChanged && this.#refs && this.#ready()) this.#subscribe();
    else if (!starting && input.archived && this.#refs && this.#ready()) this.#subscribeArchive();
    if (this.#provisional.size && !this.#pending.size) this.#pending.add("provisional");
    this.#merge();
    this.#notifications.emitAll();
    // Made after this change is announced, so the binding takes the filter's record.
    this.#persist();
    if (starting) this.#drive({ type: "filter", filter: this.#key() });
  }
  /** Remember a half the filter is leaving, unless it was only derived from another's list. */
  #keep(half: SidebarHalf): void {
    const view = half === "archive" ? this.#archive : this.#home;
    if (view && this.#provisional.get(half) !== "derived")
      this.#memory.remember(half, this.#filter.project, view);
    this.#provisional.delete(half);
  }
  /** Paint a half from memory, unconfirmed, until its subscription's snapshot lands. */
  #adopt(half: SidebarHalf): void {
    const held = this.#memory.provisional(half, this.#filter.project);
    if (half === "home") this.#rememberedResume = held?.resume;
    if (!held) return;
    if (half === "archive") this.#archive = held.view;
    else this.#home = held.view;
    this.#provisional.set(half, held.source);
    this.#confirm([half], true);
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
  #delay: (milliseconds: number, run: () => void) => () => void;
  /** Each refused window's wait before it is asked again, as its cancel. */
  #waits = new Map<SidebarHalf, () => void>();
  /** Each window's refusals in a row, for its backoff; its snapshot resets it. */
  #failures = new Map<SidebarHalf, number>();
  #wire: string | undefined;
  /**
   * Home was subscribed on this socket. The welcome's replay may come later and call
   * `reconnect` again: a Home refused meanwhile is left to its own retry, never asked at once.
   */
  #homeSent = false;
  #refs = 0;
  #homeSnapshotAllowed = true;
  #archiveSnapshotAllowed = true;
  constructor(
    limits: Limits,
    send: (message: ClientMessage) => boolean,
    id: () => string,
    ready: () => boolean,
    delay: (milliseconds: number, run: () => void) => () => void,
    persistence?: Persistence,
  ) {
    this.#persistence = persistence;
    this.#delay = delay;
    this.#limits = limits;
    this.#send = send;
    this.#id = id;
    this.#ready = ready;
    this.#notifications = new Notifications(limits.listeners);
    this.#startup = listStartup(this.#key(), {
      kept: persistence !== undefined,
      welcomed: persistence?.welcomed === undefined,
      connected: ready(),
    });
    this.#persist();
    // A welcome that fails leaves the read settling or the opening deadline to start the list.
    void persistence
      ?.welcomed?.()
      .then(() => this.#drive({ type: "welcome" }))
      .catch(() => {});
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
    const failure = this.error;
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
    if (this.#refs++ === 0) {
      if (this.#startup.phase === "waiting") {
        // Opened: its one deadline is set now, and never moved by a filter change.
        if (!this.#deadline && this.#persistence)
          this.#deadline = this.#persistence.scheduler.set(firstReadMs, () =>
            this.#drive({ type: "deadline" }),
          );
        this.#drive({ type: "held" });
      } else if (this.#ready()) this.#subscribe();
    }
    let released = false;
    return {
      store: this,
      release: () => {
        if (released) return;
        released = true;
        if (--this.#refs === 0 && this.#startup.phase === "waiting")
          this.#drive({ type: "released" });
        if (this.#refs === 0) this.#cancelRetries();
        if (this.#refs === 0 && this.#wire) {
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
  /**
   * Where the Home list can resume from: the list it holds for this filter (live before a
   * reconnect, read back from disk, or remembered), never one derived from another filter's.
   */
  #resume(): ThreadListResume | undefined {
    if (this.#fresh) {
      this.#fresh = false;
      return undefined;
    }
    const source = this.#provisional.get("home");
    if (source === "derived") return undefined;
    return source === "remembered" ? this.#rememberedResume : resumeOf(this.#home);
  }
  /** Home, and the archive when it is shown: what the list waited for before goes. */
  #subscribe(): void {
    this.#subscribeHome([]);
    if (this.#filter.archived) this.#subscribeArchive();
  }
  /** Home's window alone; the list waits for its snapshot beside `waiting`. */
  #subscribeHome(waiting: readonly string[]): void {
    // One subscription per window: a new one replaces the one it tracked.
    if (this.#wire) this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
    this.#homeSnapshotAllowed = true;
    this.#homeSent = true;
    this.#wire = this.#id();
    this.#await([...waiting, this.#wire]);
    const resume = this.#resume();
    this.#send({
      type: "subscribe",
      subscriptionId: this.#wire,
      scope: {
        kind: "threads",
        window: {
          limit: 20,
          ...(this.#filter.project ? { project: this.#filter.project } : {}),
          // Older daemons ignore it and send the whole window.
          ...(resume ? { resume } : {}),
        },
      },
      // No cursor: a windowed list starts from a fresh window, or resumes the one it holds.
    });
  }
  #subscribeArchive(): void {
    const was = this.syncing;
    if (this.#archiveWire) {
      this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
      this.#pending.delete(this.#archiveWire);
    }
    // The new wire takes the old one's place before anyone is told: a watcher never reads an
    // empty wait in between and takes the list for current.
    this.#pending.delete(refusedReason("archive"));
    this.#archiveSnapshotAllowed = true;
    this.#archiveWire = this.#id();
    this.#pending.add(this.#archiveWire);
    if (!was) this.#notifications.emit(["sync"]);
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
  /** Subscribe on a new socket; one already sent with its hello is not sent again. */
  reconnect(): void {
    if (this.#startup.phase === "waiting") this.#drive({ type: "connected" });
    else if (this.#refs && !this.#wire && !this.#homeSent) this.#subscribe();
  }
  disconnect(): void {
    this.#homeSent = false;
    // The next socket subscribes afresh; a refusal on this one waits for nothing.
    this.#cancelRetries();
    this.#failures.clear();
    if (this.#startup.phase === "waiting") this.#drive({ type: "disconnected" });
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
      const view = this.#resumed(message.view, archived ? this.#archive : this.#home);
      if (!view) {
        // It kept a thread this list no longer holds: start over with the whole window.
        this.#fresh = true;
        this.#resync();
        return;
      }
      const ids = Object.keys(view.threads);
      if (ids.length > this.#limits.entities) {
        this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, new ClientError("limit"));
        return;
      }
      this.#refused.delete(archived ? "archive" : "home");
      this.#failures.delete(archived ? "archive" : "home");
      if (message.subscriptionId === this.#archiveWire) this.#archive = view;
      else this.#home = view;
      this.#confirm([archived ? "archive" : "home"], false);
      this.#provisional.delete(archived ? "archive" : "home");
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
  /**
   * A snapshot as this list holds it: a resumed one keeps the threads it names from `held`,
   * placed as they were, and adds the ones that changed. Undefined when a kept one isn't held.
   */
  #resumed(view: ThreadListView, held: ThreadListView | undefined): ThreadListView | undefined {
    const { keep, reads, ...rest } = view;
    if (!keep) return view;
    const threads: Record<string, ThreadListEntry> = {};
    for (const id of keep) {
      const entry = held && Object.hasOwn(held.threads, id) ? held.threads[id] : undefined;
      if (!entry) return undefined;
      // A kept row's read cursor comes on its own: it may have moved while the row did not.
      const readState = reads
        ? ((Object.hasOwn(reads, id) ? reads[id] : undefined) ?? unread)
        : entry.readState;
      Object.defineProperty(threads, id, {
        value: readState === entry.readState ? entry : { ...entry, readState },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    for (const [id, entry] of Object.entries(view.threads))
      Object.defineProperty(threads, id, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return { ...rest, threads };
  }
  #resync(): void {
    if (this.#wire) this.#send({ type: "unsubscribe", subscriptionId: this.#wire });
    if (this.#archiveWire) this.#send({ type: "unsubscribe", subscriptionId: this.#archiveWire });
    this.#subscribe();
  }
}
