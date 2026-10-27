import { ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { parseThreadRecord, threadRecord } from "./read-records.ts";
import { SnapshotBinding, contentChanges, type Persistence } from "./read-snapshots.ts";
import { ThreadStore } from "./thread-store.ts";
import { ClientError, type Limits } from "./types.ts";

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
  subscriptionId: string | undefined;
  /** Its read snapshot on disk, when the client keeps them. */
  binding: SnapshotBinding | undefined;
  /** What it weighed when its last holder let go; zero while held. */
  inactiveBytes: number;
}
export interface ThreadSubscription {
  store: ThreadStore;
  release(): void;
}
export class Subscriptions {
  #cache = new Map<string, Cached>();
  #inactiveBytes = 0;
  #checkpoints = new Set<Promise<void>>();
  /** Bindings of threads already let go whose last checkpoint may still be waiting, by thread. */
  #closing = new Map<string, Set<SnapshotBinding>>();
  #persistence: Persistence | undefined;
  #starting = new Set<string>();
  #wires = new Map<string, Cached>();
  #limits: Limits;
  #send: (message: ClientMessage) => boolean;
  #id: () => string;
  #ready: () => boolean;
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
  }
  acquire(threadId: string): ThreadSubscription {
    ThreadId.parse(threadId);
    let entry = this.#cache.get(threadId);
    if (!entry) {
      if (this.#cache.size >= this.#limits.threads) {
        const evict = [...this.#cache].find(([, value]) => !value.refs);
        if (!evict) throw new ClientError("limit");
        this.#evict(evict[0], evict[1]);
      }
      entry = {
        store: new ThreadStore(this.#limits),
        threadId,
        snapshotAllowed: true,
        fresh: false,
        resumedAt: undefined,
        rejected: false,
        refs: 0,
        subscriptionId: undefined,
        binding: undefined,
        inactiveBytes: 0,
      };
      entry.binding = this.#bind(entry);
    }
    this.#cache.delete(threadId);
    this.#cache.set(threadId, entry);
    if (entry.refs++ === 0) {
      this.#inactiveBytes -= entry.inactiveBytes;
      entry.inactiveBytes = 0;
      entry.rejected = false;
      if (this.#ready()) this.#pump();
    }
    const owned = entry;
    let released = false;
    return {
      store: entry.store,
      release: () => {
        if (released) return;
        released = true;
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
        }
      },
    };
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
    const entry = this.#cache.get(threadId);
    if (!entry) return true;
    if (entry.refs) return false;
    this.#inactiveBytes -= entry.inactiveBytes;
    this.#cache.delete(threadId);
    entry.binding?.discard();
    this.#discardClosing(threadId);
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
      () => threadRecord(store.export()),
      (value) => {
        const record = parseThreadRecord(value, threadId);
        if (!record || !store.restore(record.view, record.truncated)) return;
        // The disk copy may be from another daemon run: never resume from its cursor. The
        // subscription asks for a snapshot, which merges with it by sequence (ADR 0062).
        entry.fresh = true;
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
    void written.finally(() => {
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
      if (entry.refs && !entry.rejected && !entry.subscriptionId) this.#subscribe(threadId, entry);
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
    this.#send({
      type: "subscribe",
      paced: true,
      subscriptionId: id,
      scope: { kind: "thread", threadId: ThreadId.parse(threadId) },
      ...(entry.fresh || entry.store.cursor === undefined ? {} : { afterSeq: entry.store.cursor }),
    });
  }
  reconnect(): void {
    this.#pump();
  }
  disconnect(): void {
    this.#wires.clear();
    this.#starting.clear();
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
        entry.store.setSyncing(false);
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "limit") throw error;
        this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, error);
        return;
      }
      // A complete snapshot finishes initialization itself. Keep replay paced by its
      // explicit acknowledgement, but don't leave a hydrated scope holding a startup slot.
      this.#starting.delete(message.subscriptionId);
      this.#pump();
      return;
    }
    entry.snapshotAllowed = false;
    try {
      const result = entry.store.delivery(message);
      if (result === "applied") entry.store.recover();
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
