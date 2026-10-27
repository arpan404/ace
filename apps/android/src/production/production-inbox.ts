import type { SidebarReader, ThreadReader } from "@ace/client";
import { inboxSections, type InboxThread } from "@ace/ui-core/mobile";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";
import type { StartupRoute } from "../runtime/production-startup.ts";

/**
 * Pure production inbox wiring: which rows the active machine shows, and
 * when the inbox may resolve a read-only handle at all.
 *
 * No networking, no storage and no secrets. Screens resolve the read-only
 * handle (`startup.runtimeForReading`) only when `shouldShowInbox` holds;
 * mutations never pass through here (the viewer offers no admit path and
 * never resolves `runtimeForMutation` or `manager.client`).
 */

export type ProductionInboxEntry =
  | { kind: "heading"; id: string; title: string }
  | { kind: "thread"; id: string; key: string };

/** Only a paired route may resolve a read-only handle. Anything else stays on its message. */
export function shouldShowInbox(route: StartupRoute): boolean {
  return route.route === "paired";
}

/** One daemon row for the active machine, keyed apart from other machines' same ids. */
export function inboxThreadsFor(store: SidebarReader, machineId: string): InboxThread[] {
  const threads: InboxThread[] = [];
  for (const id of store.ids) {
    const entry = store.thread(id);
    if (entry)
      threads.push({ key: `${machineId}:${id}`, machineId, entry, unconfirmed: store.unconfirmed });
  }
  return threads;
}

/** Grouped rows for the list, mirroring the fixture `Inbox` grouping. */
export function inboxEntriesFor(
  store: SidebarReader,
  machineId: string,
  now: number,
): ProductionInboxEntry[] {
  const rows: ProductionInboxEntry[] = [];
  for (const section of inboxSections(inboxThreadsFor(store, machineId), [], now)) {
    rows.push({ kind: "heading", id: `heading:${section.key}`, title: section.label });
    for (const key of section.keys) {
      const id = key.startsWith(`${machineId}:`) ? key.slice(machineId.length + 1) : key;
      rows.push({ kind: "thread", id, key });
    }
  }
  return rows;
}

/** Screen copy for a read-handle failure. Fail closed: no retry admits anything. */
export function readingFailureCopy(error: unknown): string {
  if (error instanceof Error && /not connected/i.test(error.message)) {
    return "This machine is not connected.";
  }
  return "Threads could not be loaded.";
}

/** Read-only thread headline for the thread view: title plus how many items are held. */
export function threadHeadlineFor(store: ThreadReader): { title: string; count: number } {
  return { title: store.thread?.title ?? "Thread", count: store.order.length };
}

/** Latest-N thread window. The read handle offers no paging, so the cap is stated, never silent. */
export const PRODUCTION_THREAD_WINDOW = 50;

export const MAX_AUTO_RECOVER_ATTEMPTS = 5;

/**
 * Bounded inbox list height for small screens. The machines screen stacks
 * cards, the inbox, lock settings and a footer; a bare `flex:1` inbox
 * between those siblings starves on short screens or pushes settings
 * off-screen with no scroll. The outer screen scrolls and the list keeps a
 * bounded window instead.
 */
export const INBOX_LIST_MIN_HEIGHT = 280;
export const INBOX_LIST_MAX_HEIGHT = 480;
export const THREAD_LIST_MIN_HEIGHT = 240;
export const THREAD_LIST_MAX_HEIGHT = 480;

/** Stable string identity for a startup route (fresh object per read). */
export function routeKeyFor(route: StartupRoute): string {
  return `${route.route}:${route.route === "pairing" ? route.reason : ""}`;
}

export function threadWindowFor(
  order: readonly string[],
  limit: number = PRODUCTION_THREAD_WINDOW,
): { shown: readonly string[]; total: number; truncated: number } {
  const total = order.length;
  const shown = total > limit ? order.slice(total - limit) : order.slice();
  return { shown, total, truncated: total - shown.length };
}

/**
 * Rich transcript windowing for the production read-only thread.
 *
 * Blocks are computed over the full order (grouping stays exact), then
 * filtered to the latest-N item window the read handle holds. A block is
 * kept when it names no items (end/forked/live dividers carry no item and
 * belong to the tail they close) or when any of its items sits in the shown
 * set. Rows render only the block's shown items, so a boundary work block
 * never pulls pre-window history back into view. Pure.
 */
export function windowBlocksFor(
  blocks: readonly Block[],
  shown: readonly string[] | ReadonlySet<string>,
): Block[] {
  const allowed = shown instanceof Set ? shown : new Set(shown);
  return blocks.filter((block) => {
    const ids = blockItems(block);
    if (ids.length === 0) return true;
    return ids.some((id) => allowed.has(id));
  });
}

/**
 * A block's item ids restricted to the shown window, in block order. Rows
 * read only these, so a boundary block spanning the cut renders its tail
 * without resurrecting older history. Pure.
 */
export function visibleBlockItemIds(
  block: Block,
  shown: readonly string[] | ReadonlySet<string>,
): string[] {
  const allowed = shown instanceof Set ? shown : new Set(shown);
  return blockItems(block).filter((id) => allowed.has(id));
}

/**
 * Host-switch open-thread resolution, synchronous during render. The old
 * `useEffect(setOpenId(null), [hostId])` ran after paint and flashed the old
 * thread under the new host for one commit; resolving during render never
 * paints the wrong machine's thread.
 */
export function resolveOpenIdForHost(
  prevHostId: string,
  hostId: string,
  openId: string | null,
): string | null {
  return prevHostId === hostId ? openId : null;
}

/**
 * Route-gated open thread: a revoked/pin route must never keep rendering the
 * cached thread. The inbox clears `openId` on the route flip and gates the
 * thread view on the route, so a stale `openId` never outlives pairing.
 */
export function openIdForRoute(openId: string | null, route: StartupRoute): string | null {
  return shouldShowInbox(route) ? openId : null;
}

/** True when the route permits resolving (and retaining) a read lease. */
export function shouldResolveLease(route: StartupRoute): boolean {
  return shouldShowInbox(route);
}

/**
 * Safe auto-recovery condition: re-resolve only when the retained lease is
 * dead and a fresh read handle already reports `ready`. A stale snapshot
 * never triggers it, and a revoked route never reaches it (callers gate on
 * the route first), so recovery cannot follow a new owner or bypass pairing.
 * Bounded by `MAX_AUTO_RECOVER_ATTEMPTS`: a persistently dead lease (fresh
 * `ready` but `threads()` keeps throwing) stops after the budget and waits
 * for manual Retry instead of churning leases every liveness tick.
 */
export function shouldAutoRecoverReads(
  leaseDead: boolean,
  freshConnection: string | null,
  autoAttempts = 0,
): boolean {
  if (!leaseDead) return false;
  if (freshConnection !== "ready") return false;
  return autoAttempts < MAX_AUTO_RECOVER_ATTEMPTS;
}

export interface RetryableReads {
  runtimeForReading(hostId: string): {
    reconnectNow(): void;
    wake(): void;
  };
}

/**
 * Shared Retry path: nudge the live runtime, then let the caller re-resolve.
 * `reconnectNow` first, `wake` as fallback; every failure is tolerated
 * because the re-resolve below still refreshes the fail-closed copy.
 */
export function retryReading(startup: RetryableReads, hostId: string): void {
  try {
    const handle = startup.runtimeForReading(hostId);
    try {
      handle.reconnectNow();
    } catch {
      try {
        handle.wake();
      } catch {
        /* Re-resolve still refreshes the copy. */
      }
    }
  } catch {
    /* Handle resolution itself failed; the caller still re-resolves. */
  }
}
