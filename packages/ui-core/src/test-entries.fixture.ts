import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";

/** A thread list entry as the daemon sends it, parsed through the wire schema. */
export function entry(
  id: string,
  status: ThreadStatus,
  updatedAt: number,
  extra: { workspaceId?: string; archivedAt?: number; title?: string } = {},
): ThreadListEntry {
  return ThreadListEntry.parse({
    id,
    workspaceId: extra.workspaceId ?? "ace",
    title: extra.title ?? `Thread ${id}`,
    provider: "codex",
    status,
    createdAt: 0,
    updatedAt,
    ...(extra.archivedAt === undefined ? {} : { archivedAt: extra.archivedAt }),
  });
}
