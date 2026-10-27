import type { SidebarReader, ThreadReader } from "@ace/client";
import { inboxSections, type InboxThread } from "@ace/ui-core/mobile";
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
