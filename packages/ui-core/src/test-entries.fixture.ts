import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";

/** A thread list entry as the daemon sends it, parsed through the wire schema. */
export function entry(
  id: string,
  status: ThreadStatus,
  updatedAt: number,
  extra: Record<string, unknown> = {},
): ThreadListEntry {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "codex",
    createdAt: 0,
    ...extra,
    id,
    status,
    updatedAt,
  });
}
