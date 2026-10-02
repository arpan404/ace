import type { Event, ServerMessage, SubscriptionScope, ThreadId } from "@ace/protocol";
import { createThreadListView } from "@ace/projection";
import type { Store } from "./store.ts";

/** All subscriptions carry the host-wide cursor. Thread folds ignore other threads.
 * Listener first, fixed replay head second, then queued live events beyond that head.
 * This also covers reentrant appends during snapshot/replay delivery. */
export function subscribe(
  store: Store,
  id: string,
  scope: SubscriptionScope,
  afterSeq: number | undefined,
  replayLimit: number,
  send: (message: ServerMessage) => void,
): () => void {
  let cursor = afterSeq ?? 0;
  let initializing = true;
  let queued: Event[] = [];
  let acquired: ThreadId | undefined;
  let stopped = false;
  const deliver = (events: Event[]) => {
    const missed = events.filter((event) => event.seq > cursor);
    if (!missed.length) return;
    cursor = missed.at(-1)?.seq ?? cursor;
    send({ type: "events", subscriptionId: id, events: missed });
  };
  const remove = store.subscribe((events) => {
    if (initializing) queued.push(...events);
    else deliver(events);
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    remove();
    if (acquired) store.releaseThread(acquired);
  };
  try {
    const head = store.headSeq();
    if (afterSeq !== undefined && afterSeq > head) throw new Error("Cursor ahead of log");
    // Acquire even on replay so a subscribed thread has one owned cache.
    const view =
      scope.kind === "thread"
        ? store.acquireThread(scope.threadId)
        : createThreadListView(store.listThreads(), head);
    if (scope.kind === "thread") acquired = scope.threadId;
    if (afterSeq === undefined || head - afterSeq > replayLimit) {
      cursor = head;
      send({ type: "snapshot", subscriptionId: id, seq: head, view });
    } else {
      const events = store
        .readEvents({ afterSeq, limit: replayLimit })
        .filter((event) => event.seq <= head);
      deliver(events);
    }
    initializing = false;
    const pending = queued;
    queued = [];
    deliver(pending);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
