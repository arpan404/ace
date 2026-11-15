import { WireEncoder } from "./wire-encoder.ts";
import type { DeviceId, Event, ServerMessage, SubscriptionScope, ThreadId } from "@ace/protocol";
import { changedItemId, createThreadListView, isSidebarEvent } from "@ace/projection";
import { systemDeliveryRuntime, type DeliveryRuntime } from "./delivery-runtime.ts";
import type { Store } from "./store.ts";
import { sidebarSubscription, type DeviceReads } from "./sidebar-subscription.ts";
import { SidebarPlacement } from "./sidebar-placement.ts";
import { routeThread } from "./thread-routes.ts";
import type { SnapshotTail } from "./thread-reads.ts";
import { wireEvent, wireThreadView } from "./wire-interactions.ts";
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
  Partial<
    Pick<
      Store,
      | "replaySafe"
      | "sidebarRowRevision"
      | "sidebarToken"
      | "countThreadEvents"
      | "threadReadState"
      | "onThreadRead"
    >
  >;

/** `device`'s read cursors in `store`, when the store keeps them (`DeviceReads`). */
function deviceReads(store: SubscriptionStore, device: DeviceId): DeviceReads | undefined {
  const readState = store.threadReadState?.bind(store);
  const onThreadRead = store.onThreadRead?.bind(store);
  if (!readState || !onThreadRead) return undefined;
  return {
    read(threadId) {
      const { lastSeenSeq, updatedAt } = readState(threadId, device);
      return { lastSeenSeq, updatedAt };
    },
    listen(moved) {
      return onThreadRead((threadId, deviceId) => {
        // Marked inside a command's transaction: read it once that has committed.
        if (deviceId === device) queueMicrotask(() => moved(threadId));
      });
    },
  };
}

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

/** A thread replay at or under this many bytes is sent without weighing a snapshot against it. */
const replayCompareBytes = 16 * 1024;
/**
 * `message`, a full snapshot, when it costs fewer bytes than a replay of `replayBytes` (the
 * `missed` events) and the client ends where the replay would leave it. It must hold every item
 * created after `afterSeq`, so the client keeps the history it holds (ADR 0062) instead of
 * reading it again. And every item a missed event changed must be in it: the client keeps its
 * own copy of an item the snapshot does not carry, so that change would never arrive.
 */
function smallerSnapshot(
  message: ServerMessage,
  afterSeq: number,
  missed: readonly Event[],
  replayBytes: number,
  encoder: WireEncoder,
): ServerMessage | undefined {
  if (message.type !== "snapshot" || message.view.kind !== "thread") return undefined;
  const view = message.view;
  if (view.itemsBefore !== null && view.itemsBefore > afterSeq + 1) return undefined;
  for (const event of missed) {
    // The same definition clients catch their reads up by (`changedItemId`).
    const changed = changedItemId(event.payload);
    if (changed !== undefined && !Object.hasOwn(view.items, changed)) return undefined;
  }
  return Buffer.byteLength(encoder.encode(message)) < replayBytes ? message : undefined;
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
  tail?: SnapshotTail,
  device?: DeviceId,
): () => void {
  if (scope.kind === "threads" && scope.window) {
    const window = sidebarSubscription(
      store,
      id,
      scope.window,
      send,
      placement ?? storePlacement(store, Date.now),
      device === undefined ? undefined : deviceReads(store, device),
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
    const selected = events
      .filter((event) => event.seq > cursor && event.seq <= head && matches(event))
      .map(wireEvent);
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
        scope.kind === "thread"
          ? wireThreadView(
              store.snapshotThread(
                scope.threadId,
                // Only a first open is cut to a tail. A client resuming from a cursor holds a
                // copy: it gets the full snapshot, so what it keeps of that copy is what a full
                // one answers (ADR 0062), never items a tail and its fill would leave stale.
                afterSeq === undefined ? tail : undefined,
              ),
            )
          : structuredClone(view);
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
              .filter((event) => event.seq <= head)
              .map(wireEvent);
        const bytes = events.reduce((total, event) => total + encoder.eventBytes(event), 0);
        const snapshot = (): ServerMessage => {
          const view =
            scope.kind === "thread"
              ? wireThreadView(store.snapshotThread(scope.threadId))
              : createThreadListView(store.listThreads());
          return { type: "snapshot", subscriptionId: id, seq: head, view: { ...view, seq: head } };
        };
        // A thread's replay after a long streamed turn is mostly deltas: when a snapshot of the
        // thread now costs fewer bytes, it is sent instead (the client resumes its held
        // transcript from it, ADR 0062). Small replays skip the comparison.
        const cheaper =
          scope.kind === "thread" && bytes > replayCompareBytes
            ? smallerSnapshot(snapshot(), afterSeq, events, bytes, encoder)
            : undefined;
        if (
          overflows ||
          events.length > replayLimit ||
          bytes > replayFrameBytes * 2 ||
          events.some((event) => encoder.eventBytes(event) > replayFrameBytes)
        ) {
          cursor = progressHead = head;
          send(cheaper ?? snapshot());
        } else if (cheaper) {
          cursor = progressHead = head;
          send(cheaper);
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
