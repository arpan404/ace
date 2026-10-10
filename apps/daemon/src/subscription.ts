import { WireEncoder } from "./wire-encoder.ts";
import type { Event, ServerMessage, SubscriptionScope, ThreadId } from "@ace/protocol";
import { createThreadListView, isSidebarEvent } from "@ace/projection";
import { systemDeliveryRuntime, type DeliveryRuntime } from "./delivery-runtime.ts";
import type { Store } from "./store.ts";
import { sidebarSubscription } from "./sidebar-subscription.ts";
const windows = new WeakMap<() => void, ReturnType<typeof sidebarSubscription>>();
export function pageSubscription(
  stop: () => void,
  before: import("@ace/protocol").ThreadListCursor,
  requestId: string,
): void {
  const window = windows.get(stop);
  if (!window) throw new Error("Subscription is not paginated");
  window.page(before, requestId);
}

export type SubscriptionStore = Pick<
  Store,
  | "getThread"
  | "snapshotThread"
  | "subscribe"
  | "headSeq"
  | "acquireThread"
  | "releaseThread"
  | "listThreads"
  | "sidebarPage"
  | "readEvents"
>;

/**
 * Replay is split into frames of about this many event bytes, well below the client's 2 MiB
 * frame limit. A single larger event still travels alone.
 */
const replayFrameBytes = 1024 * 1024;
function replayFrames(events: Event[], encoder: WireEncoder): Event[][] {
  const frames: Event[][] = [];
  let frame: Event[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = encoder.eventBytes(event);
    if (frame.length && bytes + size > replayFrameBytes) {
      frames.push(frame);
      frame = [];
      bytes = 0;
    }
    frame.push(event);
    bytes += size;
  }
  if (frame.length) frames.push(frame);
  return frames;
}

/** Delivery covers (afterSeq, throughSeq], including events filtered out by scope. */
export function subscribe(
  store: SubscriptionStore,
  id: string,
  scope: SubscriptionScope,
  afterSeq: number | undefined,
  replayLimit: number,
  send: (message: ServerMessage) => void,
  progressIntervalMs = 250,
  schedule: DeliveryRuntime["delay"] = systemDeliveryRuntime.delay,
  paced = false,
  encoder = new WireEncoder(),
): () => void {
  if (scope.kind === "threads" && scope.window) {
    const window = sidebarSubscription(store, id, scope.window, send);
    const stop = () => window.stop();
    windows.set(stop, window);
    if (paced) send({ type: "subscription.ready", subscriptionId: id, seq: store.headSeq() });
    return stop;
  }
  let cursor = afterSeq ?? 0;
  let initializing = true;
  let queued: Event[] = [];
  let acquired: ThreadId | undefined;
  let stopped = false;
  let progressHead = cursor;
  let progressTimer: (() => void) | undefined;
  const matches = (event: Event) =>
    scope.kind === "thread" ? event.threadId === scope.threadId : isSidebarEvent(event);
  const cancelProgress = () => {
    progressTimer?.();
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
      const frames = replayFrames(selected, encoder);
      for (const [index, frame] of frames.entries()) {
        if (stopped) return;
        // Frames stay contiguous: each covers up to its last event, the final one up to head.
        const previous = cursor;
        cursor = index === frames.length - 1 ? head : (frame.at(-1)?.seq ?? head);
        send({
          type: "events",
          subscriptionId: id,
          afterSeq: previous,
          throughSeq: cursor,
          events: frame,
        });
      }
    } else if (replay) {
      cancelProgress();
      flushProgress();
    } else if (!progressTimer) {
      progressTimer = schedule(flushProgress, progressIntervalMs);
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
    const initialHead = afterSeq === undefined ? undefined : store.headSeq();
    if (afterSeq !== undefined && initialHead !== undefined && afterSeq > initialHead)
      throw new Error("Cursor ahead of log");
    if (afterSeq === undefined || (initialHead ?? 0) - afterSeq > replayLimit) {
      const view =
        scope.kind === "thread"
          ? store.acquireThread(scope.threadId)
          : createThreadListView(store.listThreads());
      if (scope.kind === "thread") acquired = scope.threadId;
      const snapshotView =
        scope.kind === "thread" ? store.snapshotThread(scope.threadId) : structuredClone(view);
      const head = store.headSeq();
      snapshotView.seq = head;
      cursor = head;
      progressHead = head;
      send({ type: "snapshot", subscriptionId: id, seq: head, view: snapshotView });
    } else {
      if (scope.kind === "thread" && !store.getThread(scope.threadId))
        throw new Error("Unknown thread");
      const head = initialHead ?? 0;
      if (head > afterSeq) {
        // head - afterSeq <= replayLimit, so a thread filter still sees every event it needs.
        const events = store
          .readEvents({
            afterSeq,
            limit: replayLimit,
            byteLimit: replayFrameBytes * 2,
            ...(scope.kind === "thread" ? { threadId: scope.threadId } : {}),
          })
          .filter((event) => event.seq <= head);
        const bytes = events.reduce((total, event) => total + encoder.eventBytes(event), 0);
        if (
          bytes > replayFrameBytes * 2 ||
          events.some((event) => encoder.eventBytes(event) > replayFrameBytes)
        ) {
          const view =
            scope.kind === "thread"
              ? store.snapshotThread(scope.threadId)
              : createThreadListView(store.listThreads());
          view.seq = head;
          cursor = progressHead = head;
          send({ type: "snapshot", subscriptionId: id, seq: head, view });
        } else deliver(events, head, true);
      }
    }
    if (paced) send({ type: "subscription.ready", subscriptionId: id, seq: cursor });
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
