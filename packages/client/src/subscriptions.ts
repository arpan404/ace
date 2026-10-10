import { ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { ThreadStore } from "./thread-store.ts";
import { ClientError, type Limits } from "./types.ts";

interface Cached {
  store: ThreadStore;
  threadId: string;
  snapshotAllowed: boolean;
  fresh: boolean;
  rejected: boolean;
  refs: number;
  subscriptionId: string | undefined;
}
export interface ThreadSubscription {
  store: ThreadStore;
  release(): void;
}
export class Subscriptions {
  #cache = new Map<string, Cached>();
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
  ) {
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
        this.#cache.delete(evict[0]);
      }
      entry = {
        store: new ThreadStore(this.#limits),
        threadId,
        snapshotAllowed: true,
        fresh: false,
        rejected: false,
        refs: 0,
        subscriptionId: undefined,
      };
    }
    this.#cache.delete(threadId);
    this.#cache.set(threadId, entry);
    if (entry.refs++ === 0) {
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
          this.#cache.delete(threadId);
          this.#cache.set(threadId, owned);
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
      if (
        !entry.snapshotAllowed ||
        (entry.store.cursor !== undefined && message.seq < entry.store.cursor)
      )
        return;
      entry.snapshotAllowed = false;
      entry.fresh = false;
      if (message.view.thread.id !== entry.threadId) throw new ClientError("protocol");
      try {
        entry.store.snapshot(message.view);
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "limit") throw error;
        this.#send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, error);
      }
      // A complete snapshot finishes initialization itself. Keep replay paced by its
      // explicit acknowledgement, but don't leave a hydrated scope holding a startup slot.
      this.#starting.delete(message.subscriptionId);
      this.#pump();
      return;
    }
    entry.snapshotAllowed = false;
    try {
      if (entry.store.delivery(message) !== "gap") return;
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
