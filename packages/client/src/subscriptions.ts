import { ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { SnapshotBinding, type ReadSnapshotStorage } from "./read-snapshots.ts";
import type { Scheduler } from "./types.ts";
import { ThreadStore } from "./thread-store.ts";
import { ClientError, type Limits } from "./types.ts";

interface Cached {
  persistence?: SnapshotBinding;
  store: ThreadStore;
  threadId: string;
  snapshotAllowed: boolean;
  fresh: boolean;
  rejected: boolean;
  refs: number;
  inactiveBytes: number;
  subscriptionId: string | undefined;
}
export interface ThreadSubscription {
  store: ThreadStore;
  release(): void;
}
export class Subscriptions {
  #cache = new Map<string, Cached>();
  #inactiveBytes = 0;
  #checkpoints = new Set<Promise<void>>();
  #checkpoint(entry: Cached): void {
    const pending = entry.persistence?.close();
    if (!pending) return;
    this.#checkpoints.add(pending);
    void pending.finally(() => this.#checkpoints.delete(pending));
  }
  #evict(threadId: string, entry: Cached): void {
    this.#inactiveBytes -= entry.inactiveBytes;
    this.#cache.delete(threadId);
    this.#checkpoint(entry);
  }
  #retain(entry: Cached): void {
    this.#inactiveBytes -= entry.inactiveBytes;
    entry.inactiveBytes = entry.store.retainedBytes();
    this.#inactiveBytes += entry.inactiveBytes;
    for (const [id, cached] of this.#cache) {
      if (this.#inactiveBytes <= 16 * 1024 * 1024) break;
      if (!cached.refs) this.#evict(id, cached);
    }
  }
  #starting = new Set<string>();
  #wires = new Map<string, Cached>();
  #limits: Limits;
  #send: (message: ClientMessage) => boolean;
  #id: () => string;
  #ready: () => boolean;
  #persistence: { storage: ReadSnapshotStorage; scheduler: Scheduler } | undefined;
  constructor(
    limits: Limits,
    send: (message: ClientMessage) => boolean,
    id: () => string,
    ready: () => boolean,
    persistence?: { storage: ReadSnapshotStorage; scheduler: Scheduler },
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
        rejected: false,
        refs: 0,
        inactiveBytes: 0,
        subscriptionId: undefined,
      };
    }
    if (!entry.persistence && this.#persistence) {
      const owned = entry;
      entry.persistence = new SnapshotBinding(
        this.#persistence.storage,
        this.#persistence.scheduler,
        `thread:${threadId}`,
        (changed) => owned.store.observe(changed),
        () => owned.store.persisted(),
        (value) => {
          owned.store.hydrate(value, threadId);
          // The already-started wire requested a full snapshot; do not resume a cold preview.
          if (owned.store.cursor !== undefined) owned.fresh = true;
          if (!owned.refs && this.#cache.get(threadId) === owned) this.#retain(owned);
        },
      );
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
          if (owned.store.cursor !== undefined) owned.store.setSyncing(true);
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
  cached(threadId: string): ThreadStore | undefined {
    return this.#cache.get(threadId)?.store;
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
  close(): Promise<void> {
    for (const entry of this.#cache.values()) this.#checkpoint(entry);
    return Promise.all(this.#checkpoints).then(() => {});
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
    entry.store.fail(error);
    this.#pump();
  }
  receive(message: ServerMessage): void {
    if (message.type === "subscription.ready") {
      const entry = this.#wires.get(message.subscriptionId);
      if (!entry) return;
      if (entry.store.cursor === message.seq) {
        entry.store.recover();
        entry.store.setSyncing(false);
      }
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
      // A new wire's authoritative snapshot may rewind a live-only tail lost on daemon crash.
      // Wire identity and the one-snapshot acceptance window fence stale snapshots instead.
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
    // Release this in-flight slot before queueing a cursor-free replacement.
    this.#starting.delete(message.subscriptionId);
    entry.subscriptionId = undefined;
    entry.fresh = true;
    this.#pump();
  }
}
