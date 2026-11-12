import type { ThreadListEntry, ThreadListCursor, ThreadListWindow } from "@ace/protocol";
import { threadAttention } from "./thread-attention.ts";
/**
 * In the Settled section. Working work always resurfaces, and so does a thread waiting on the
 * person (a question or an approval), while it waits: settled or not, it is never out of sight
 * then. It stays settled, so it returns to Settled once answered. A queue needing recovery
 * resurfaces an automatically settled thread; a thread the person settled by hand comes back
 * only when their own message may not have gone (not sent, or not known to have arrived). A
 * failure after the thread was settled brings it back until the person reads it; one from before
 * stays, since settling it was their answer to that.
 */
export function sidebarSettled(entry: ThreadListEntry): boolean {
  if (entry.settledAt === undefined) return false;
  if (entry.status.state === "working" || entry.status.state === "needs_you") return false;
  if (failedSinceSettled(entry, entry.settledAt)) return false;
  const attention = threadAttention(entry);
  if (entry.settledReason !== "manual") return !attention;
  return attention !== "not_sent" && attention !== "uncertain";
}

function failedSinceSettled(entry: ThreadListEntry, settledAt: number): boolean {
  if (entry.status.state !== "failed") return false;
  const failedAt = entry.activityAt ?? entry.updatedAt;
  return failedAt > settledAt && !(entry.readAt !== undefined && entry.readAt >= failedAt);
}
export function sidebarVisible(entry: ThreadListEntry, archived = false): boolean {
  return (
    entry.deletedAt === undefined &&
    entry.host === undefined &&
    (entry.archivedAt !== undefined) === archived
  );
}
export function sidebarPage(
  entries: readonly ThreadListEntry[],
  options: { limit: number; project?: string | undefined; archived?: boolean | undefined },
  before?: ThreadListCursor,
): { threads: ThreadListEntry[]; window: ThreadListWindow } {
  const visible = entries.filter((entry) => sidebarVisible(entry, options.archived));
  const counts = new Map<string, number>();
  for (const entry of visible)
    if (
      entry.delegatedFrom === undefined &&
      entry.hasSentMessage !== false &&
      !(
        entry.hasSentMessage === undefined &&
        entry.status.state === "new" &&
        entry.title === "New thread"
      )
    )
      counts.set(entry.workspaceId, (counts.get(entry.workspaceId) ?? 0) + 1);
  const matching = visible.filter(
    (entry) => !options.project || entry.workspaceId === options.project,
  );
  const paged = (entry: ThreadListEntry) =>
    options.archived || (!entry.pinned && sidebarSettled(entry));
  const at = (entry: ThreadListEntry) =>
    options.archived
      ? (entry.archivedAt ?? entry.updatedAt)
      : (entry.activityAt ?? entry.updatedAt);
  const settled = matching
    .filter(paged)
    .toSorted((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const next = settled
    .filter(
      (entry) =>
        !before || at(entry) < before.at || (at(entry) === before.at && entry.id > before.id),
    )
    .slice(0, options.limit + 1);
  const page = next.slice(0, options.limit);
  const last = page.at(-1);
  return {
    threads: [
      ...(before
        ? []
        : matching
            .filter((entry) => !paged(entry))
            .toSorted((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
      ...page,
    ],
    window: {
      before: next.length > options.limit && last ? { at: at(last), id: last.id } : null,
      total: settled.length,
      counts: [...counts]
        .map(([id, threads]) => ({ id, threads }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    },
  };
}
