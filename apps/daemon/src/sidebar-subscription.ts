import { createThreadListView, isSidebarEvent } from "@ace/projection";
import { ThreadId } from "@ace/protocol";
import type {
  Event,
  ServerMessage,
  SubscriptionScope,
  ThreadListCursor,
  ThreadListEntry,
  ThreadListWindow,
} from "@ace/protocol";
import { PlacedEntries, type SidebarPlacement } from "./sidebar-placement.ts";
import type { SubscriptionStore } from "./subscription.ts";

export interface SidebarSubscription {
  stop(): void;
  page(before: ThreadListCursor, requestId: string): void;
}

type WindowOptions = NonNullable<Extract<SubscriptionScope, { kind: "threads" }>["window"]>;

const samePlace = (a: ThreadListEntry | undefined, b: ThreadListEntry) =>
  JSON.stringify(a?.place) === JSON.stringify(b.place);

/**
 * A windowed thread list (ADR 0107): every live thread and the newest settled page, each sent
 * with the place the daemon gives it in the Threads panel (`SidebarPlacement`). A change sends
 * only the threads it touched, each placed anew, so a thread that moves tabs costs one entry.
 * A list that resumes from a revision of this database and epoch gets only what changed since,
 * and the ids it keeps; any other starts from the whole window.
 */
export function sidebarSubscription(
  store: SubscriptionStore,
  id: string,
  options: WindowOptions,
  send: (message: ServerMessage) => void,
  placement: SidebarPlacement,
): SidebarSubscription {
  const { resume, ...scope } = options;
  /** The daemon's rows as last read, keyed by id: what a live read reuses. */
  const selected = new Map<string, ThreadListEntry>();
  /** What the client was last sent for each row, with its place. */
  const sent = new Map<string, ThreadListEntry>();
  const places = new PlacedEntries(placement);
  let stopped = false;
  let initializing = true;
  let queued: Event[] = [];
  let before: ThreadListCursor | null = null;
  let limit = scope.limit;
  let window: ThreadListWindow | undefined;
  const stamped = (current: ThreadListWindow): ThreadListWindow => ({
    ...current,
    epoch: placement.epoch,
  });
  const deliver = (events: Event[]) => {
    if (stopped || !events.some(isSidebarEvent)) return;
    const changed = new Set(events.filter(isSidebarEvent).map((event) => event.threadId));
    const current = store.sidebarPage({ ...scope, limit }, undefined, {
      entries: selected,
      changed,
    });
    const present = new Set<string>(current.threads.map((entry) => entry.id));
    const threads: Record<string, ThreadListEntry> = {};
    const removed: ThreadId[] = [];
    for (const threadId of selected.keys())
      if (!present.has(threadId)) {
        selected.delete(threadId);
        sent.delete(threadId);
        removed.push(ThreadId.parse(threadId));
      }
    for (const entry of current.threads) {
      if (changed.has(entry.id) || selected.get(entry.id) !== entry) {
        const placed = places.placed(entry);
        Object.defineProperty(threads, entry.id, {
          value: placed,
          enumerable: true,
          configurable: true,
        });
        sent.set(entry.id, placed);
      }
      selected.set(entry.id, entry);
    }
    before = current.window.before;
    window = stamped(current.window);
    send({
      type: "threads.patch",
      subscriptionId: id,
      seq: store.headSeq(),
      threads,
      removed,
      window,
    });
  };
  /** What places threads changed (the sort, the seen baseline): send only the threads that moved. */
  const replace = () => {
    if (stopped || initializing || !window) return;
    const threads: Record<string, ThreadListEntry> = {};
    for (const [threadId, entry] of selected) {
      const placed = places.placed(entry);
      if (samePlace(sent.get(threadId), placed)) continue;
      Object.defineProperty(threads, threadId, {
        value: placed,
        enumerable: true,
        configurable: true,
      });
      sent.set(threadId, placed);
    }
    window = stamped(window);
    send({
      type: "threads.patch",
      subscriptionId: id,
      seq: store.headSeq(),
      threads,
      removed: [],
      window,
    });
  };
  const stopListening = store.subscribe((events) => {
    if (initializing) queued.push(...events);
    else deliver(events);
  });
  const stopPlacing = placement.subscribe(replace);
  try {
    const initial = store.sidebarPage(scope);
    before = initial.window.before;
    window = stamped(initial.window);
    const revision = initial.window.revision;
    // Resumable only from this database and epoch, and from a revision this one has reached.
    const resumable =
      resume !== undefined &&
      revision !== undefined &&
      resume.epoch === placement.epoch &&
      resume.revision <= revision;
    const keep: ThreadId[] = [];
    const fresh: ThreadListEntry[] = [];
    for (const entry of initial.threads) {
      selected.set(entry.id, entry);
      const placed = places.placed(entry);
      sent.set(entry.id, placed);
      const read = store.sidebarRowRevision?.(entry);
      if (resumable && read !== undefined && read <= resume.revision)
        keep.push(ThreadId.parse(entry.id));
      else fresh.push(placed);
    }
    const view = createThreadListView(fresh);
    view.seq = store.headSeq();
    view.window = window;
    if (resumable) view.keep = keep;
    send({ type: "snapshot", subscriptionId: id, seq: view.seq, view });
    initializing = false;
    deliver(queued);
    queued = [];
  } catch (error) {
    stopListening();
    stopPlacing();
    throw error;
  }
  return {
    stop() {
      stopped = true;
      stopListening();
      stopPlacing();
    },
    page(cursor, requestId) {
      if (stopped || !before || cursor.at !== before.at || cursor.id !== before.id)
        throw new Error("Stale page cursor");
      const next = store.sidebarPage(scope, cursor);
      const threads: Record<string, ThreadListEntry> = {};
      for (const entry of next.threads) {
        selected.set(entry.id, entry);
        const placed = places.placed(entry);
        sent.set(entry.id, placed);
        Object.defineProperty(threads, entry.id, {
          value: placed,
          enumerable: true,
          configurable: true,
        });
      }
      limit += next.threads.length;
      before = next.window.before;
      // A page keeps the list's revision: rows older than the window don't advance it.
      window = stamped({ ...next.window, revision: window?.revision ?? next.window.revision });
      send({
        type: "threads.patch",
        subscriptionId: id,
        requestId,
        seq: store.headSeq(),
        threads,
        removed: [],
        window,
      });
    },
  };
}
