import { ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { parseThreadRecord, threadRecord } from "./read-records.ts";
import { SnapshotBinding, contentChanges, type Persistence } from "./read-snapshots.ts";
import { ThreadStore } from "./thread-store.ts";
import { ClientError, type Limits, type OpenTail } from "./types.ts";

/** Stores no view holds stay cached while together they weigh at most this (ADR 0056). */
export const inactiveThreadBytes = 16 * 1024 * 1024;

interface Cached {
  store: ThreadStore;
  threadId: string;
  snapshotAllowed: boolean;
  fresh: boolean;
  /** The cursor the last gap resumed from: a second gap there starts over without one. */
  resumedAt: number | undefined;
  rejected: boolean;
  refs: number;
  /** Of `refs`, the optional ones: an entry held only by them gives way to a thread opened. */
  optionalRefs: number;
  /** Given up for a foreground thread: its holders' releases no longer count. */
  preempted: boolean;
  subscriptionId: string | undefined;
  /** Its read snapshot on disk, when the client keeps them. */
  binding: SnapshotBinding | undefined;
  /** What it weighed when its last holder let go; zero while held. */
  inactiveBytes: number;
  /**
   * The daemon database its cursor came from, when known: the one a live frame arrived under, or
   * the one a disk copy was kept under. Kept with the record (ADR 0128).
   */
  database: string | undefined;
  /** Its cursor came from disk and no live frame has confirmed it yet. */
  restored: boolean;
  /** Its kept record is still being read: it subscribes once that settles. */
  loading: boolean;
  /** Completions of a tail-only copy that failed in a row, and the retry waiting, if any. */
  completions: number;
  retry: (() => void) | undefined;
}
/**
 * Threads open with a small tail (`ClientOptions.openTail`). A store that holds only a tail is
 * completed by subscribing again with neither a cursor nor a tail: the daemon's full snapshot
 * replaces it, as an open without a tail gets. `delay` paces retries of a completion that fails.
 */
export interface TailOpen {
  tail: OpenTail;
  delay(milliseconds: number, run: () => void): () => void;
}
export interface ThreadSubscription {
  store: ThreadStore;
  release(): void;
}
/** How a caller holds a thread: `optional` only takes spare room and yields it when needed. */
export interface AcquireOptions {
  optional?: boolean | undefined;
}
export class Subscriptions {
  #cache = new Map<string, Cached>();
  #roomListeners = new Set<() => void>();
  #room: number;
  #inactiveBytes = 0;
  #checkpoints = new Set<Promise<void>>();
  /** Bindings of threads already let go whose last checkpoint may still be waiting, by thread. */
  #closing = new Map<string, Set<SnapshotBinding>>();
  #persistence: Persistence | undefined;
  #starting = new Set<string>();
  #wires = new Map<string, Cached>();
  /** The database the current connection's daemon named, if it named one. */
  #database: string | undefined;
  /** This socket's hello is out and its welcome not yet in: subscribes go ahead of it. */
  #early = false;
  /** Subscribes sent ahead of the welcome with a cursor, and the database each one assumed. */
  #assumed = new Map<string, string | undefined>();
  #limits: Limits;
  #send: (message: ClientMessage) => boolean;
  #id: () => string;
  #ready: () => boolean;
  #tail: TailOpen | undefined;
  constructor(
    limits: Limits,
    send: (message: ClientMessage) => boolean,
    id: () => string,
    ready: () => boolean,
    persistence?: Persistence,
    tail?: TailOpen,
  ) {
    this.#tail = tail;
    this.#persistence = persistence;
    this.#limits = limits;
    this.#send = send;
    this.#id = id;
    this.#ready = ready;
    this.#room = this.#freeRoom();
  }
  /**
   * Hold a thread. A foreground hold (default) takes a slot whenever one can be had, giving a
   * thread held only by optional holders up if it must. An optional hold takes a new slot only
   * while more than `threadReserve` stay free; refused, its store's error reads `no_room`.
   */
  acquire(threadId: string, options: AcquireOptions = {}): ThreadSubscription {
    ThreadId.parse(threadId);
    const optional = options.optional === true;
    let entry = this.#cache.get(threadId);
    if (optional && !entry?.refs && this.#room <= 0) {
      // Refused, the way a store says it: its error reads `no_room` and nothing is held.
      const refused = new ThreadStore(this.#limits);
      refused.fail(new ClientError("no_room", "No room for an optional thread subscription"));
      return { store: refused, release: () => {} };
    }
    if (!entry) {
      if (this.#cache.size >= this.#limits.threads) {
        const evict = [...this.#cache].find(([, value]) => !value.refs);
        const yielding = evict
          ? undefined
          : [...this.#cache].find(([, value]) => value.refs === value.optionalRefs);
        if (evict) this.#evict(evict[0], evict[1]);
        else if (yielding) this.#preempt(yielding[0], yielding[1]);
        else throw new ClientError("limit");
      }
      entry = {
        store: new ThreadStore(this.#limits),
        threadId,
        snapshotAllowed: true,
        fresh: false,
        resumedAt: undefined,
        rejected: false,
        refs: 0,
        optionalRefs: 0,
        preempted: false,
        subscriptionId: undefined,
        binding: undefined,
        inactiveBytes: 0,
        database: undefined,
        restored: false,
        loading: false,
        completions: 0,
        retry: undefined,
      };
      entry.binding = this.#bind(entry);
      if (entry.binding) {
        const loading = entry;
        loading.loading = true;
        // `loaded` settles on its own deadline; only a throw in the pump can reject it.
        void loading.binding?.loaded
          .then(() => {
            loading.loading = false;
            this.#pump();
          })
          .catch(() => {});
      }
    }
    this.#cache.delete(threadId);
    this.#cache.set(threadId, entry);
    if (optional) entry.optionalRefs++;
    if (entry.refs++ === 0) {
      this.#inactiveBytes -= entry.inactiveBytes;
      entry.inactiveBytes = 0;
      entry.rejected = false;
      if (this.#ready()) this.#pump();
      this.#roomChanged();
    }
    const owned = entry;
    let released = false;
    return {
      store: entry.store,
      release: () => {
        if (released || owned.preempted) return;
        released = true;
        if (optional) owned.optionalRefs--;
        if (--owned.refs === 0) {
          if (owned.subscriptionId) {
            this.#send({ type: "unsubscribe", subscriptionId: owned.subscriptionId });
            this.#wires.delete(owned.subscriptionId);
            this.#starting.delete(owned.subscriptionId);
          }
          owned.subscriptionId = undefined;
          // Unfollowed from here on: a view painting from it shows that it may be behind.
          if (owned.store.cursor !== undefined) {
            owned.store.setSyncing(true);
            owned.store.setUnconfirmed(true);
          }
          this.#cache.delete(threadId);
          this.#cache.set(threadId, owned);
          this.#retain(owned);
          this.#pump();
          this.#roomChanged();
        }
      },
    };
  }
  /**
   * Complete a store that holds only a small tail: resubscribe with neither a cursor nor a tail
   * (`#resumable` is false for it), so the daemon's full snapshot replaces what it holds.
   */
  #complete(entry: Cached): void {
    if (entry.subscriptionId) {
      this.#send({ type: "unsubscribe", subscriptionId: entry.subscriptionId });
      this.#wires.delete(entry.subscriptionId);
      this.#starting.delete(entry.subscriptionId);
    }
    entry.subscriptionId = undefined;
    this.#pump();
  }
  /** Slots an optional hold may still take: free ones beyond the reserve. */
  room(): number {
    return this.#room;
  }
  /** Called whenever `room()` changes, so a refused optional holder knows when to try again. */
  onRoom(listener: () => void): () => void {
    this.#roomListeners.add(listener);
    return () => void this.#roomListeners.delete(listener);
  }
  #freeRoom(): number {
    let held = 0;
    for (const entry of this.#cache.values()) if (entry.refs) held++;
    return Math.max(0, this.#limits.threads - this.#limits.threadReserve - held);
  }
  #roomChanged(): void {
    const room = this.#freeRoom();
    if (room === this.#room) return;
    this.#room = room;
    for (const listener of this.#roomListeners) listener();
  }
  /**
   * Give up a thread only optional holders keep, for a thread the person opened: its holders read
   * `no_room` as the store's error and may hold it again once there is room.
   */
  #preempt(threadId: string, entry: Cached): void {
    entry.preempted = true;
    if (entry.subscriptionId) {
      this.#send({ type: "unsubscribe", subscriptionId: entry.subscriptionId });
      this.#wires.delete(entry.subscriptionId);
      this.#starting.delete(entry.subscriptionId);
    }
    entry.subscriptionId = undefined;
    this.#cache.delete(threadId);
    this.#checkpoint(entry);
    entry.store.setSyncing(false);
    entry.store.fail(new ClientError("no_room", "Gave its room to a thread you opened"));
  }
  /** The store of a thread some caller holds, without taking a lease. */
  held(threadId: string): ThreadStore | undefined {
    const entry = this.#cache.get(threadId);
    return entry?.refs ? entry.store : undefined;
  }
  /** A thread's store whether or not anyone holds it, without taking a lease. */
  cached(threadId: string): ThreadStore | undefined {
    return this.#cache.get(threadId)?.store;
  }
  /**
   * Let go of a thread nobody holds, without writing its read snapshot, so the next open reads
   * it from the daemon. False when someone holds it: what they show stays live.
   */
  discard(threadId: string): boolean {
    // Checkpoints of the thread's earlier stores, already let go, go first: one may still be
    // queued behind a write in flight, even when no store is cached now.
    this.#discardClosing(threadId);
    const entry = this.#cache.get(threadId);
    if (!entry) return true;
    if (entry.refs) return false;
    this.#inactiveBytes -= entry.inactiveBytes;
    this.#cache.delete(threadId);
    entry.binding?.discard();
    return true;
  }
  /** A thread let go earlier may still have a checkpoint queued: it must not land after a drop. */
  #discardClosing(threadId: string): void {
    for (const binding of this.#closing.get(threadId) ?? []) binding.discard();
    this.#closing.delete(threadId);
  }
  /** Let go of every thread nobody holds, as `discard` does. */
  discardUnheld(): void {
    for (const threadId of this.#cache.keys()) this.discard(threadId);
    for (const threadId of this.#closing.keys()) this.#discardClosing(threadId);
  }
  /** Checkpoint every read snapshot; resolves once all of them, and earlier ones, are written. */
  close(): Promise<void> {
    for (const entry of this.#cache.values()) this.#checkpoint(entry);
    return Promise.all(this.#checkpoints).then(() => {});
  }
  #bind(entry: Cached): SnapshotBinding | undefined {
    if (!this.#persistence) return undefined;
    const { store, threadId } = entry;
    return new SnapshotBinding(
      this.#persistence,
      `thread:${threadId}`,
      contentChanges((tap) => store.observe(tap)),
      // A store holding only a tail keeps nothing on disk: any reader, this build's or an older
      // one that would drop the `partial` mark, then restores the thread as holding nothing and
      // opens it fresh. A record from before stays a complete copy at its own, older cursor.
      () => (store.filling ? undefined : threadRecord(store.export(), entry.database)),
      (value) => {
        const record = parseThreadRecord(value, threadId);
        if (!record || !store.restore(record.view, record.truncated)) return;
        // The disk copy resumes from its cursor only under the database it was kept under
        // (`#resumable`); otherwise the subscription asks for a snapshot, which merges with it by
        // sequence (ADR 0062, ADR 0128).
        entry.restored = true;
        entry.database = record.databaseId;
        // Known to be another database's copy, however late it loaded: replace, never merge.
        if (this.#mismatched(entry)) entry.store.replaceOnSnapshot();
        if (!entry.refs && this.#cache.get(threadId) === entry) this.#retain(entry);
      },
    );
  }
  #checkpoint(entry: Cached): void {
    const binding = entry.binding;
    const written = binding?.close();
    if (!binding || !written) return;
    this.#checkpoints.add(written);
    const closing = this.#closing.get(entry.threadId) ?? new Set();
    closing.add(binding);
    this.#closing.set(entry.threadId, closing);
    // A checkpoint that fails writes nothing; the next change writes the newest copy.
    void written
      .catch(() => {})
      .finally(() => {
        this.#checkpoints.delete(written);
        closing.delete(binding);
        if (!closing.size && this.#closing.get(entry.threadId) === closing)
          this.#closing.delete(entry.threadId);
      });
  }
  #evict(threadId: string, entry: Cached): void {
    this.#inactiveBytes -= entry.inactiveBytes;
    entry.inactiveBytes = 0;
    this.#cache.delete(threadId);
    this.#checkpoint(entry);
  }
  /** Weigh a store nobody holds, then let the least recently used go past the budget. */
  #retain(entry: Cached): void {
    this.#inactiveBytes -= entry.inactiveBytes;
    entry.inactiveBytes = entry.store.retainedBytes();
    this.#inactiveBytes += entry.inactiveBytes;
    for (const [id, cached] of this.#cache) {
      if (this.#inactiveBytes <= inactiveThreadBytes) break;
      if (!cached.refs) this.#evict(id, cached);
    }
  }
  #pump(): void {
    if (!this.#ready()) return;
    for (const [threadId, entry] of this.#cache) {
      if (!this.#ready() || this.#starting.size >= 4) break;
      if (entry.refs && !entry.rejected && !entry.subscriptionId && !entry.loading)
        this.#subscribe(threadId, entry);
    }
  }
  #subscribe(threadId: string, entry: Cached): void {
    const id = this.#id();
    entry.snapshotAllowed = true;
    entry.subscriptionId = id;
    // Data already shown is behind until this subscription's replay or snapshot lands.
    if (entry.store.cursor !== undefined) entry.store.setSyncing(true);
    this.#wires.set(id, entry);
    this.#starting.add(id);
    const resumable = this.#resumable(entry);
    if (resumable && this.#early) this.#assumed.set(id, this.#database ?? entry.database);
    this.#send({
      type: "subscribe",
      paced: true,
      subscriptionId: id,
      scope: { kind: "thread", threadId: ThreadId.parse(threadId) },
      ...(resumable ? { afterSeq: entry.store.cursor } : {}),
      // Only a store holding nothing opens from a small tail: one holding a copy resumes or
      // takes a full snapshot, so nothing it keeps outlives what a full snapshot answers. The
      // same before the welcome (a subscribe in the hello's flight) as after it.
      ...(this.#tail && entry.store.cursor === undefined ? { tail: this.#tail.tail } : {}),
    });
  }
  /**
   * Whether `entry` may resume from its cursor: not after a gap there, and for a copy from disk,
   * only under the database that copy was kept under.
   */
  #resumable(entry: Cached): boolean {
    // A copy that holds only a tail, live or from disk, is replaced by the full snapshot.
    if (entry.store.filling) {
      entry.store.replaceOnSnapshot();
      return false;
    }
    if (entry.fresh || entry.store.cursor === undefined) return false;
    if (!entry.restored) return true;
    // Ahead of the first welcome, a disk copy assumes the database it was kept under.
    const database = this.#database ?? (this.#early ? entry.database : undefined);
    if (entry.database !== undefined && entry.database === database) return true;
    // Known to be another database's: its sequences say nothing here, so nothing of it is kept.
    if (this.#mismatched(entry)) entry.store.replaceOnSnapshot();
    return false;
  }
  /** `entry` holds a copy known to come from another database than the daemon's. */
  #mismatched(entry: Cached): boolean {
    return (
      entry.restored &&
      entry.database !== undefined &&
      this.#database !== undefined &&
      entry.database !== this.#database
    );
  }
  /**
   * The daemon's welcome named `databaseId`. A cursor is a position in one database: past a
   * change of database (a restore or reset under the same host id), every held cursor reads
   * afresh.
   */
  database(databaseId: string | undefined): void {
    const changed = this.#database !== undefined && this.#database !== databaseId;
    this.#database = databaseId;
    this.#early = false;
    const assumed = this.#assumed;
    this.#assumed = new Map();
    if (changed)
      for (const entry of this.#cache.values()) {
        entry.fresh = true;
        entry.database = undefined;
        entry.restored = false;
        entry.store.replaceOnSnapshot();
      }
    // A subscribe sent with the hello resumed under the database it assumed. Under another one
    // its cursor means nothing: drop it before any of its frames land, and subscribe afresh.
    for (const [id, database] of assumed) {
      const entry = this.#wires.get(id);
      if (database === databaseId || !entry) continue;
      this.#send({ type: "unsubscribe", subscriptionId: id });
      this.#wires.delete(id);
      this.#starting.delete(id);
      entry.subscriptionId = undefined;
    }
  }
  /** This socket's hello went out: subscribe now, ahead of the welcome. */
  early(): void {
    this.#early = true;
    this.#pump();
  }
  /** A live frame for `entry` landed: its cursor is now the current database's. */
  #confirmed(entry: Cached): void {
    entry.restored = false;
    entry.database = this.#database;
  }
  reconnect(): void {
    this.#pump();
  }
  disconnect(): void {
    this.#wires.clear();
    this.#starting.clear();
    this.#early = false;
    this.#assumed.clear();
    for (const entry of this.#cache.values()) {
      entry.subscriptionId = undefined;
      entry.rejected = false;
      // What a view shows now waits for the next connection to catch it up.
      if (entry.refs && entry.store.cursor !== undefined) entry.store.setSyncing(true);
    }
  }
  reject(id: string, error: ClientError): void {
    const entry = this.#wires.get(id);
    if (!entry) return;
    this.#wires.delete(id);
    this.#starting.delete(id);
    entry.subscriptionId = undefined;
    entry.rejected = true;
    entry.store.setSyncing(false);
    entry.store.fail(error);
    // A tail-only copy never rests as if complete: its completion is tried again, with backoff,
    // while the thread stays held (and on the next connection, which subscribes it afresh).
    if (this.#tail && entry.store.filling && entry.refs && !entry.retry) {
      const wait = Math.min(30_000, 500 * 2 ** entry.completions++);
      entry.retry = this.#tail.delay(wait, () => {
        entry.retry = undefined;
        entry.rejected = false;
        this.#pump();
      });
    }
    this.#pump();
  }
  receive(message: ServerMessage): void {
    if (message.type === "subscription.ready") {
      const entry = this.#wires.get(message.subscriptionId);
      if (!entry) return;
      if (entry.store.cursor === message.seq) entry.store.recover();
      entry.store.setSyncing(false);
      // Caught up by replay or snapshot: the daemon has confirmed what the store holds.
      entry.store.setUnconfirmed(false);
      this.#starting.delete(message.subscriptionId);
      this.#pump();
      return;
    }
    if (message.type !== "snapshot" && message.type !== "events" && message.type !== "progress")
      return;
    const entry = this.#wires.get(message.subscriptionId);
    if (!entry) return;
    if (message.type === "snapshot") {
      if (message.view.kind !== "thread") throw new ClientError("protocol");
      // A new subscription's one snapshot is the daemon's head, even below the held cursor: a
      // daemon that crashed lost the tail it had sent (and a disk copy may be from another run).
      // The store then replaces what it held. Wire ids fence snapshots from older subscriptions.
      if (!entry.snapshotAllowed) return;
      entry.snapshotAllowed = false;
      entry.fresh = false;
      if (message.view.thread.id !== entry.threadId) throw new ClientError("protocol");
      try {
        entry.store.snapshot(message.view);
        this.#confirmed(entry);
        entry.store.setSyncing(false);
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "limit") throw error;
        this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, error);
        return;
      }
      // A small tail paints first; the full snapshot that replaces it is asked for at once.
      if (entry.store.filling) {
        this.#complete(entry);
        return;
      }
      entry.completions = 0;
      // A complete snapshot finishes initialization itself. Keep replay paced by its
      // explicit acknowledgement, but don't leave a hydrated scope holding a startup slot.
      this.#starting.delete(message.subscriptionId);
      this.#pump();
      return;
    }
    // Events applied ahead of the subscription (ADR 0155): they confirm nothing, keep the
    // thread syncing, and leave the subscription free to answer with a snapshot. One that
    // doesn't follow what the store holds is dropped; the subscription covers it.
    if (message.type === "events" && message.early) {
      try {
        entry.store.delivery(message);
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "limit") throw error;
      }
      return;
    }
    entry.snapshotAllowed = false;
    try {
      const result = entry.store.delivery(message);
      if (result === "applied") {
        this.#confirmed(entry);
        entry.store.recover();
      }
      if (result !== "gap") return;
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== "limit") throw error;
      this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
      this.reject(message.subscriptionId, error);
      return;
    }
    this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
    this.#wires.delete(message.subscriptionId);
    const threadId = entry.store.thread?.id;
    if (!threadId) throw new ClientError("protocol");
    // Release this in-flight slot before queueing the replacement. It resumes from the held
    // cursor, so a missed frame costs a replay (or a snapshot merged into what is held), never
    // the loaded history (ADR 0062). A gap again at the same cursor starts over without it.
    this.#starting.delete(message.subscriptionId);
    entry.subscriptionId = undefined;
    const cursor = entry.store.cursor;
    entry.fresh = cursor === undefined || entry.resumedAt === cursor;
    entry.resumedAt = entry.fresh ? undefined : cursor;
    this.#pump();
  }
}
