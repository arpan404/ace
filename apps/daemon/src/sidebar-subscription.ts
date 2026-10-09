import { createThreadListView, isSidebarEvent } from "@ace/projection";
import { ThreadId } from "@ace/protocol";
import type {
  Event,
  ServerMessage,
  SubscriptionScope,
  ThreadListCursor,
  ThreadListEntry,
} from "@ace/protocol";
import type { SubscriptionStore } from "./subscription.ts";

export interface SidebarSubscription {
  stop(): void;
  page(before: ThreadListCursor, requestId: string): void;
}
export function sidebarSubscription(
  store: SubscriptionStore,
  id: string,
  options: NonNullable<Extract<SubscriptionScope, { kind: "threads" }>["window"]>,
  send: (message: ServerMessage) => void,
): SidebarSubscription {
  const selected = new Map<string, ThreadListEntry>();
  let stopped = false;
  let initializing = true;
  let queued: Event[] = [];
  let before: ThreadListCursor | null = null;
  let limit = options.limit;
  const deliver = (events: Event[]) => {
    if (stopped || !events.some(isSidebarEvent)) return;
    const current = store.sidebarPage({ ...options, limit });
    const present = new Set<string>(current.threads.map((entry) => entry.id));
    const changed = new Set(events.filter(isSidebarEvent).map((event) => event.threadId));
    const threads: Record<string, ThreadListEntry> = {};
    const removed: import("@ace/protocol").ThreadId[] = [];
    for (const threadId of selected.keys())
      if (!present.has(threadId)) {
        selected.delete(threadId);
        removed.push(ThreadId.parse(threadId));
      }
    for (const entry of current.threads) {
      if (changed.has(entry.id) || !selected.has(entry.id))
        Object.defineProperty(threads, entry.id, {
          value: entry,
          enumerable: true,
          configurable: true,
        });
      selected.set(entry.id, entry);
    }
    before = current.window.before;
    send({
      type: "threads.patch",
      subscriptionId: id,
      seq: store.headSeq(),
      threads,
      removed,
      window: current.window,
    });
  };
  const stopListening = store.subscribe((events) => {
    if (initializing) queued.push(...events);
    else deliver(events);
  });
  try {
    const initial = store.sidebarPage(options);
    for (const entry of initial.threads) selected.set(entry.id, entry);
    before = initial.window.before;

    const view = createThreadListView(initial.threads);
    view.seq = store.headSeq();
    view.window = initial.window;
    send({ type: "snapshot", subscriptionId: id, seq: view.seq, view });
    initializing = false;
    deliver(queued);
    queued = [];
  } catch (error) {
    stopListening();
    throw error;
  }
  return {
    stop() {
      stopped = true;
      stopListening();
    },
    page(cursor, requestId) {
      if (stopped || !before || cursor.at !== before.at || cursor.id !== before.id)
        throw new Error("Stale page cursor");
      const next = store.sidebarPage(options, cursor);
      for (const entry of next.threads) selected.set(entry.id, entry);
      limit += next.threads.length;
      before = next.window.before;
      send({
        type: "threads.patch",
        subscriptionId: id,
        requestId,
        seq: store.headSeq(),
        threads: Object.fromEntries(next.threads.map((entry) => [entry.id, entry])),
        removed: [],
        window: next.window,
      });
    },
  };
}
