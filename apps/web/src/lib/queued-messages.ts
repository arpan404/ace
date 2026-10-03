import type { ClientApi, ThreadReader } from "@ace/client";
import { arrayEqual, useClient, useThread } from "@ace/client-react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** A message sent while the agent was busy, until the daemon delivers it into the transcript. */
export interface QueuedMessage {
  intentId: string;
  text: string;
  /** How many times this text was already in the transcript when it was queued. */
  before: number;
}

type Queues = ReadonlyMap<string, readonly QueuedMessage[]>;

/**
 * Messages this window queued, per thread. The daemon reports only that a thread waits on its
 * queue, not what is in it, so the window that sent them keeps the list; every reader (the
 * composer's pills, the Agents tab) uses this one store. One per client, so it is dropped with
 * the connection.
 */
class QueueStore {
  private queues: Queues = new Map();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = (): Queues => this.queues;
  update(threadId: string, change: (list: readonly QueuedMessage[]) => readonly QueuedMessage[]) {
    const next = new Map(this.queues);
    const list = change(this.queues.get(threadId) ?? []);
    if (list.length) next.set(threadId, list);
    else next.delete(threadId);
    this.queues = next;
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<ClientApi, QueueStore>();
function storeFor(client: ClientApi): QueueStore {
  let store = stores.get(client);
  if (!store) {
    store = new QueueStore();
    stores.set(client, store);
  }
  return store;
}

const recent = 50;
function userTexts(reader: ThreadReader): string[] {
  const texts: string[] = [];
  for (const id of reader.order.slice(-recent)) {
    const item = reader.item(id);
    if (item?.type === "message" && item.role === "user")
      texts.push(item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""));
  }
  return texts;
}
const none: readonly QueuedMessage[] = [];

/**
 * The thread's queued messages still waiting, and ways to add and remove one. A message drops
 * out as soon as the transcript shows it delivered.
 */
export function useQueuedMessages(threadId: string) {
  const store = storeFor(useClient());
  const queues = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const delivered = useThread(threadId, ["order"], userTexts, arrayEqual);
  const count = useCallback(
    (text: string) => (delivered ?? []).filter((candidate) => candidate === text).length,
    [delivered],
  );
  const queued = useMemo(
    () => (queues.get(threadId) ?? none).filter((message) => count(message.text) <= message.before),
    [queues, threadId, count],
  );
  const add = useCallback(
    (message: { intentId: string; text: string }) =>
      store.update(threadId, (list) => [
        ...list.filter((queuedMessage) => count(queuedMessage.text) <= queuedMessage.before),
        { ...message, before: count(message.text) },
      ]),
    [store, threadId, count],
  );
  const remove = useCallback(
    (intentId: string) =>
      store.update(threadId, (list) => list.filter((message) => message.intentId !== intentId)),
    [store, threadId],
  );
  return { queued, add, remove };
}
