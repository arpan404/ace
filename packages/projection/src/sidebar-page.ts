import type { ThreadListEntry, ThreadListCursor, ThreadListWindow } from "@ace/protocol";
import { threadAttention } from "./thread-attention.ts";
export function sidebarSettled(entry: ThreadListEntry): boolean {
  return entry.settledAt !== undefined && entry.status.state === "done" && !threadAttention(entry);
}
export function sidebarVisible(entry: ThreadListEntry, archived = false): boolean {
  return entry.deletedAt === undefined && (entry.archivedAt !== undefined) === archived;
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
