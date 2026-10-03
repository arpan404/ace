import type { FileChange, Item } from "@ace/protocol";

/** A file one thread's agents changed, with every change its tool calls carried, in order. */
export interface ChangedFile {
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  path: string;
  changes: readonly FileChange[];
  updatedAt: number;
}

/**
 * The files a thread's tool calls changed, one entry per path (a move counts under its new
 * path), newest change last. Pure: the same rule the Changes tab uses for a turn's files.
 */
export function threadFiles(
  thread: { id: string; title: string; workspaceId: string },
  items: readonly Item[],
): ChangedFile[] {
  const byPath = new Map<string, { changes: FileChange[]; updatedAt: number }>();
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const detail = item.call.detail;
    if (!("changes" in detail)) continue;
    for (const change of detail.changes) {
      const path = change.kind === "move" && change.movePath ? change.movePath : change.path;
      const file = byPath.get(path) ?? { changes: [], updatedAt: 0 };
      file.changes.push(change);
      file.updatedAt = Math.max(file.updatedAt, item.call.endedAt ?? item.call.startedAt);
      byPath.set(path, file);
    }
  }
  return [...byPath].map(([path, file]) => ({
    threadId: thread.id,
    threadTitle: thread.title,
    workspaceId: thread.workspaceId,
    path,
    changes: file.changes,
    updatedAt: file.updatedAt,
  }));
}

/**
 * The file as the agent wrote it, when its last change created it whole. An edit's text may be
 * only the replaced snippet and a patch can't rebuild the file, so those have none.
 */
export function writtenText(file: Pick<ChangedFile, "changes">): string | undefined {
  const last = file.changes.at(-1);
  return last?.kind === "add" && !last.diff ? last.newText : undefined;
}
