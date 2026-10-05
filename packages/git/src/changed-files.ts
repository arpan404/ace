import { diff } from "./diff.ts";
import { serial } from "./lock.ts";
import type { Repository } from "./repository.ts";
import type { ChangedFile, DiffEntry, StatusEntry } from "./types.ts";

const kinds: Record<string, ChangedFile["status"]> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
};

/** What one status entry amounts to against HEAD, from its index and worktree letters. */
function kindOf(entry: StatusEntry): ChangedFile["status"] {
  if (entry.oldPath) return "renamed";
  for (const letter of [entry.worktreeStatus, entry.indexStatus])
    if (letter === "D") return "deleted";
  return kinds[entry.indexStatus] ?? "modified";
}

/**
 * Exactly the files `git status` reports (staged, unstaged, conflicted and untracked, ignored
 * files excluded), each with its lines changed against HEAD, sorted by path and capped at
 * `limit`. What a commit of the checkout would take, listed before it does.
 */
export async function changedFiles(
  repository: Repository,
  worktree: string,
  limit: number,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const root = await repository.root(worktree);
  return serial(root, async () => {
    const [status, info] = await Promise.all([repository.status(root), repository.info(root)]);
    const counts = new Map<string, DiffEntry>();
    if (info.head) {
      const changes = await diff(
        repository,
        root,
        { kind: "commit", ref: info.head },
        { kind: "working-tree" },
        // Counts only: the patch itself isn't needed.
        1,
      );
      for (const entry of changes.entries) counts.set(entry.path, entry);
    }
    const files = new Map<string, ChangedFile>();
    const add = (path: string, kind: ChangedFile["status"], from?: string) => {
      if (files.has(path)) return;
      const counted = counts.get(path);
      files.set(path, {
        path,
        ...(from ? { from } : {}),
        status: kind,
        additions: counted?.additions ?? 0,
        deletions: counted?.deletions ?? 0,
        binary: counted?.binary ?? false,
      });
    };
    for (const entry of [...status.conflicted, ...status.staged, ...status.unstaged])
      add(entry.path, kindOf(entry), entry.oldPath);
    for (const path of status.untracked) add(path, "untracked");
    const sorted = [...files.values()].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return { files: sorted.slice(0, limit), truncated: sorted.length > limit };
  });
}
