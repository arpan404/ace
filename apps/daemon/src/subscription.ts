import { WireEncoder } from "./wire-encoder.ts";
import type { Event, ServerMessage, SubscriptionScope, ThreadId } from "@ace/protocol";
import { createThreadListView, isSidebarEvent } from "@ace/projection";
import { systemDeliveryRuntime, type DeliveryRuntime } from "./delivery-runtime.ts";
import type { Store } from "./store.ts";
import { sidebarSubscription } from "./sidebar-subscription.ts";
import { SidebarPlacement } from "./sidebar-placement.ts";
import { routeThread } from "./thread-routes.ts";
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
> &
  Partial<Pick<Store, "replaySafe" | "sidebarRowRevision" | "sidebarToken" | "countThreadEvents">>;

const fallbackPlacements = new WeakMap<object, SidebarPlacement>();
/**
 * Placement for a store run without the daemon's services (tests, tools): the default sort, no
 * seen baseline. The daemon passes its own (`services.sidebarPlacement`).
 */
export function storePlacement(store: SubscriptionStore, now: () => number): SidebarPlacement {
  let placement = fallbackPlacements.get(store);
  if (!placement) {
    placement = new SidebarPlacement(store.sidebarToken?.() ?? "store", now);
    fallbackPlacements.set(store, placement);
  }
  return placement;
}

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
  placement?: SidebarPlacement,
): () => void {
  if (scope.kind === "threads" && scope.window) {
    const window = sidebarSubscription(
      store,
      id,
      scope.window,
      send,
      placement ?? storePlacement(store, Date.now),
    );
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
  // Batches heard while the subscription starts, and the newest head among them.
  let queuedHead = 0;
  const hear = (events: Event[], head = events.at(-1)?.seq ?? 0) => {
    if (!initializing) deliver(events, head);
    else {
      queued.push(...events);
      queuedHead = Math.max(queuedHead, head);
    }
  };
  // A thread subscription hears only its thread's events, plus each batch's head for progress.
  const remove =
    scope.kind === "thread"
      ? routeThread(store, scope.threadId, hear)
      : store.subscribe((events) => hear(events));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelProgress();
    remove();
    if (acquired) store.releaseThread(acquired);
  };
  try {
    let replaySafe = afterSeq === undefined;
    if (afterSeq !== undefined) {
      try {
        replaySafe = store.replaySafe?.(afterSeq) !== false;
      } catch {
        // A cursor past even the reserved high-water mark cannot replay safely.
        // Fall through to a fresh snapshot rather than surfacing a replay error.
        replaySafe = false;
      }
    }
    // Replay safety drains pending writes; compare the cursor with the resulting head.
    const initialHead = afterSeq === undefined ? undefined : store.headSeq();
    // A thread's replay is bounded by its own events, read below; a list's by the host's (ADR 0128).
    const tooFar =
      scope.kind !== "thread" &&
      afterSeq !== undefined &&
      (initialHead ?? 0) - afterSeq > replayLimit;
    if (afterSeq === undefined || afterSeq > (initialHead ?? 0) || tooFar || !replaySafe) {
      const view =
        scope.kind === "thread"
          ? store.acquireThread(scope.threadId)
          : createThreadListView(store.listThreads());
      if (scope.kind === "thread") acquired = scope.threadId;
      // A thread's snapshot is shared and frozen: send a copy of its top level with the head.
      const snapshotView =
        scope.kind === "thread" ? store.snapshotThread(scope.threadId) : structuredClone(view);
      const head = store.headSeq();
      cursor = head;
      progressHead = head;
      send({
        type: "snapshot",
        subscriptionId: id,
        seq: head,
        view: { ...snapshotView, seq: head },
      });
    } else {
      if (scope.kind === "thread" && !store.getThread(scope.threadId))
        throw new Error("Unknown thread");
      const head = initialHead ?? 0;
      if (head > afterSeq) {
        // A list is within replayLimit of head already; a thread reads one past the limit of its
        // own events, so more than the limit shows as overflow and gets a snapshot.
        // Too many events shows from the index alone, before any payload is read.
        const overflows =
          scope.kind === "thread" &&
          store.countThreadEvents !== undefined &&
          store.countThreadEvents(scope.threadId, afterSeq, head, replayLimit + 1) > replayLimit;
        const events = overflows
          ? []
          : store
              .readEvents({
                afterSeq,
                limit: replayLimit + 1,
                byteLimit: replayFrameBytes * 2,
                ...(scope.kind === "thread" ? { threadId: scope.threadId } : {}),
              })
              .filter((event) => event.seq <= head);
        const bytes = events.reduce((total, event) => total + encoder.eventBytes(event), 0);
        if (
          overflows ||
          events.length > replayLimit ||
          bytes > replayFrameBytes * 2 ||
          events.some((event) => encoder.eventBytes(event) > replayFrameBytes)
        ) {
          const view =
            scope.kind === "thread"
              ? store.snapshotThread(scope.threadId)
              : createThreadListView(store.listThreads());
          cursor = progressHead = head;
          send({ type: "snapshot", subscriptionId: id, seq: head, view: { ...view, seq: head } });
        } else deliver(events, head, true);
      }
    }
    if (paced) send({ type: "subscription.ready", subscriptionId: id, seq: cursor });
    initializing = false;
    const pending = queued;
    queued = [];
    deliver(pending, Math.max(queuedHead, pending.at(-1)?.seq ?? 0));
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
