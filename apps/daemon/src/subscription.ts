import type { Event, ServerMessage, SubscriptionScope, ThreadId } from "@ace/protocol";
import { createThreadListView, isSidebarEvent } from "@ace/projection";
import { snapshotWindow } from "./snapshot-window.ts";
import type { Store } from "./store.ts";

export type SubscriptionStore = Pick<
  Store,
  "subscribe" | "headSeq" | "acquireThread" | "releaseThread" | "listThreads" | "readEvents"
>;

/** Delivery covers (afterSeq, throughSeq], including events filtered out by scope. */
export function subscribe(
  store: SubscriptionStore,
  id: string,
  scope: SubscriptionScope,
  afterSeq: number | undefined,
  replayLimit: number,
  send: (message: ServerMessage) => void,
  progressIntervalMs = 250,
): () => void {
  let cursor = afterSeq ?? 0;
  let initializing = true;
  let queued: Event[] = [];
  let acquired: ThreadId | undefined;
  let stopped = false;
  let progressHead = cursor;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const matches = (event: Event) =>
    scope.kind === "thread" ? event.threadId === scope.threadId : isSidebarEvent(event);
  const cancelProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = undefined;
  };
  const flushProgress = () => {
    progressTimer = undefined;
    if (stopped || progressHead <= cursor) return;
    const previous = cursor;
    cursor = progressHead;
    send({ type: "progress", subscriptionId: id, afterSeq: previous, throughSeq: cursor });
  };
  const deliver = (events: Event[], head = events.at(-1)?.seq ?? cursor, replay = false) => {
    if (head <= cursor) return;
    const selected = events.filter(
      (event) => event.seq > cursor && event.seq <= head && matches(event),
    );
    progressHead = Math.max(progressHead, head);
    if (selected.length) {
      cancelProgress();
      const previous = cursor;
      cursor = head;
      send({
        type: "events",
        subscriptionId: id,
        afterSeq: previous,
        throughSeq: head,
        events: selected,
      });
    } else if (replay) {
      cancelProgress();
      flushProgress();
    } else if (!progressTimer) {
      progressTimer = setTimeout(flushProgress, progressIntervalMs);
      progressTimer.unref();
    }
  };
  const remove = store.subscribe((events) => {
    if (initializing) queued.push(...events);
    else deliver(events);
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelProgress();
    remove();
    if (acquired) store.releaseThread(acquired);
  };
  try {
    const view =
      scope.kind === "thread"
        ? store.acquireThread(scope.threadId)
        : createThreadListView(store.listThreads());
    if (scope.kind === "thread") acquired = scope.threadId;
    const snapshotView = view.kind === "thread" ? snapshotWindow(view) : structuredClone(view);
    const head = store.headSeq();
    snapshotView.seq = head;
    if (afterSeq !== undefined && afterSeq > head) throw new Error("Cursor ahead of log");
    if (afterSeq === undefined || head - afterSeq > replayLimit) {
      cursor = head;
      progressHead = head;
      send({ type: "snapshot", subscriptionId: id, seq: head, view: snapshotView });
    } else {
      const events = store
        .readEvents({ afterSeq, limit: replayLimit })
        .filter((event) => event.seq <= head);
      deliver(events, head, true);
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
