import type { Selection } from "./observable.ts";
import { WeakTaps } from "./weak-taps.ts";
import type { ThreadKey, ThreadReader } from "./readers.ts";
import { mergeBySeq } from "@ace/projection";
import { type ThreadSource } from "./api.ts";
import type { Item } from "@ace/protocol";

/*
 * A thread seen through a jumped window of its history (ADR 0062): the window's items stand in
 * for the leased live tail's, while agents, runs, interactions, tasks and the thread itself stay
 * live. A view inside `ThreadWindowProvider` reads the window through the same hooks it reads
 * the tail with, so one renderer serves both.
 */

/** A window's items, oldest first and contiguous, and the cursor before its first item. */
export interface ThreadWindow {
  items: readonly Item[];
  /** Each item's creation sequence; a joined window merges with the tail by it. */
  seqs?: ReadonlyMap<string, number> | undefined;
  before: number | null;
  /** Deletions retained by the window owner across joining, detachment and source replacement. */
  deleted?: Set<string>;
  /**
   * The window meets the live tail: the tail's items from the window's first on join it, merged
   * by creation sequence and deduplicated by id (the tail's copy winning), and they stay live.
   */
  joined?: boolean | undefined;
}

/** Follow explicit deletions in detached windows, just like select(). */
function withoutHistory(keys: ReadonlySet<string>): ReadonlySet<string> {
  return keys.has("history") ? new Set([...keys].filter((key) => key !== "history")) : keys;
}

/**
 * The live source with its items replaced by the window's. A window never changes in place:
 * a slid window is a new source, so selections over items re-run when it is swapped in.
 */
export function windowSource(live: ThreadSource, window: ThreadWindow): ThreadSource {
  const items = new Map<string, Item>();
  for (const item of window.items) items.set(item.id, item);
  const own = window.items.map((item) => item.id);
  const joined = window.joined === true;
  // A joined order follows the tail's; it is rebuilt only when the tail's order changes.
  const deleted = window.deleted ?? new Set<string>();
  const isDeleted = (id: string) => {
    if (live.deleted?.(id)) {
      if (items.has(id)) deleted.add(id);
      return true;
    }
    return deleted.has(id);
  };
  const seqOf = (id: string) => window.seqs?.get(id) ?? live.itemSeq?.(id);
  const firstSeq = own.length ? seqOf(own[0] ?? "") : undefined;
  // Without every window item's sequence there is no order to merge by: show the window alone.
  const mergeable = joined && own.every((id) => seqOf(id) !== undefined);
  let tailOrder: readonly string[] | undefined;
  let order: readonly string[] = own;
  const currentOrder = () => {
    if (live.order === tailOrder) return order;
    tailOrder = live.order;
    const kept = own.filter((id) => !isDeleted(id));
    // The tail's items from the window's first on; older ones (root items the tail kept long
    // ago) would sit above the window with a hole between them.
    const tail = mergeable
      ? tailOrder.filter((id) => {
          if (items.has(id)) return false;
          const seq = live.itemSeq?.(id);
          return seq !== undefined && (firstSeq === undefined || seq >= firstSeq);
        })
      : [];
    order = tail.length ? mergeBySeq(kept, tail, seqOf) : kept;
    return order;
  };
  const item = (id: string) =>
    isDeleted(id) ? undefined : joined ? (live.item(id) ?? items.get(id)) : items.get(id);
  const taps = new WeakTaps(live, withoutHistory);
  const source: ThreadSource = {
    get error() {
      return live.error;
    },
    get syncing() {
      return live.syncing ?? false;
    },
    get unconfirmed() {
      return live.unconfirmed ?? false;
    },
    get thread() {
      return live.thread;
    },
    get queue() {
      return live.queue;
    },
    get context() {
      return live.context;
    },
    get cursor() {
      return live.cursor;
    },
    get order() {
      return currentOrder();
    },
    itemsBefore: window.before,
    agentIds: () => live.agentIds(),
    // Retained runs carry both silent continuation membership and root start timestamps.
    runIds: () => live.runIds?.() ?? [],
    children: (agentId) => live.children(agentId),
    interactionIds: () => live.interactionIds(),
    taskIds: () => live.taskIds(),
    item,
    itemSeq: seqOf,
    deleted: isDeleted,
    agent: (id) => live.agent(id),
    run: (id) => live.run(id),
    interaction: (id) => live.interaction(id),
    task: (id) => live.task(id),
    usage: (id) => live.usage(id),
    contextMeter: (id) => live.contextMeter(id),
    usageSnapshot: (key) => live.usageSnapshot(key),
    // A window's own items arrive whole from the daemon's bounded reply; nothing was cut here.
    truncated: (id) => (items.has(id) && !(joined && live.item(id)) ? false : live.truncated(id)),
    // A tap lasts while this source or its unsubscribe is held, never as long as the live
    // store: caches keyed by a window observe it and never unsubscribe.
    observe: (tap) => taps.add(tap),
    select<T>(
      keys: readonly ThreadKey[],
      selector: (reader: ThreadReader) => T,
      equal?: (a: T, b: T) => boolean,
    ): Selection<T> {
      // Detached windows keep their text, but explicit deletions remain live.
      const liveKeys = keys.filter((key) => key !== "history");
      if (!liveKeys.length) {
        const value = selector(source);
        return { getSnapshot: () => value, subscribe: () => () => {} };
      }
      return live.select(liveKeys, () => selector(source), equal);
    },
  };
  return source;
}
