import { ThreadId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { ThreadStore } from "./thread-store.ts";
import { ClientError, type Limits } from "./types.ts";

interface Cached {
  store: ThreadStore;
  threadId: string;
  snapshotAllowed: boolean;
  refs: number;
  subscriptionId: string | undefined;
}
export interface ThreadSubscription {
  store: ThreadStore;
  release(): void;
}
export class Subscriptions {
  private cache = new Map<string, Cached>();
  private wires = new Map<string, Cached>();
  private limits: Limits;
  private send: (message: ClientMessage) => boolean;
  private id: () => string;
  private ready: () => boolean;
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
  }
  acquire(threadId: string): ThreadSubscription {
    ThreadId.parse(threadId);
    let entry = this.cache.get(threadId);
    if (!entry) {
      if (this.cache.size >= this.limits.threads) {
        const evict = [...this.cache].find(([, value]) => !value.refs);
        if (!evict) throw new ClientError("limit");
        this.cache.delete(evict[0]);
      }
      entry = {
        store: new ThreadStore(this.limits),
        threadId,
        snapshotAllowed: true,
        refs: 0,
        subscriptionId: undefined,
      };
    }
    this.cache.delete(threadId);
    this.cache.set(threadId, entry);
    if (entry.refs++ === 0 && this.ready()) this.subscribe(threadId, entry);
    const owned = entry;
    let released = false;
    return {
      store: entry.store,
      release: () => {
        if (released) return;
        released = true;
        if (--owned.refs === 0) {
          if (owned.subscriptionId) {
            this.send({ type: "unsubscribe", subscriptionId: owned.subscriptionId });
            this.wires.delete(owned.subscriptionId);
          }
          owned.subscriptionId = undefined;
          this.cache.delete(threadId);
          this.cache.set(threadId, owned);
        }
      },
    };
  }
  /** The store of a thread some caller holds, without taking a lease. */
  held(threadId: string): ThreadStore | undefined {
    const entry = this.cache.get(threadId);
    return entry?.refs ? entry.store : undefined;
  }
  private subscribe(threadId: string, entry: Cached): void {
    const id = this.id();
    entry.snapshotAllowed = true;
    entry.subscriptionId = id;
    this.wires.set(id, entry);
    this.send({
      type: "subscribe",
      subscriptionId: id,
      scope: { kind: "thread", threadId: ThreadId.parse(threadId) },
      ...(entry.store.cursor === undefined ? {} : { afterSeq: entry.store.cursor }),
    });
  }
  reconnect(): void {
    for (const [threadId, entry] of this.cache) if (entry.refs) this.subscribe(threadId, entry);
  }
  disconnect(): void {
    this.wires.clear();
    for (const entry of this.cache.values()) entry.subscriptionId = undefined;
  }
  reject(id: string, error: ClientError): void {
    const entry = this.wires.get(id);
    if (!entry) return;
    this.wires.delete(id);
    entry.subscriptionId = undefined;
    entry.store.fail(error);
  }
  receive(message: ServerMessage): void {
    if (message.type !== "snapshot" && message.type !== "events" && message.type !== "progress")
      return;
    const entry = this.wires.get(message.subscriptionId);
    if (!entry) return;
    if (message.type === "snapshot") {
      if (message.view.kind !== "thread") throw new ClientError("protocol");
      if (
        !entry.snapshotAllowed ||
        (entry.store.cursor !== undefined && message.seq < entry.store.cursor)
      )
        return;
      entry.snapshotAllowed = false;
      if (message.view.thread.id !== entry.threadId) throw new ClientError("protocol");
      try {
        entry.store.snapshot(message.view);
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== "limit") throw error;
        this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
        this.reject(message.subscriptionId, error);
      }
      return;
    }
    entry.snapshotAllowed = false;
    try {
      if (entry.store.delivery(message) !== "gap") return;
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== "limit") throw error;
      this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
      this.reject(message.subscriptionId, error);
      return;
    }
    this.send({ type: "unsubscribe", subscriptionId: message.subscriptionId });
    this.wires.delete(message.subscriptionId);
    const threadId = entry.store.thread?.id;
    if (!threadId) throw new ClientError("protocol");
    // A fresh id discards frames from the old replay. Omit cursor to force snapshot.
    const id = this.id();
    entry.snapshotAllowed = true;
    entry.subscriptionId = id;
    this.wires.set(id, entry);
    this.send({ type: "subscribe", subscriptionId: id, scope: { kind: "thread", threadId } });
  }
}
