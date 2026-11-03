import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "./repository.ts";

/**
 * A cheap identity of what a HEAD-to-working-tree diff would read: HEAD, every path `git status`
 * lists with its status letters, and each listed file's size, times, inode and mode. Two equal
 * stamps mean the diff is the same, so it can be served from a cache instead of snapshotting the
 * checkout again. Unlisted files match HEAD by git's own stat check, so they add nothing.
 *
 * Undefined when a stamp can't vouch for the content: a submodule or a nested repository (its
 * files change without its listed path changing), or any listed path that is a directory.
 */
export async function checkoutStamp(
  repository: Repository,
  root: string,
): Promise<string | undefined> {
  const { status, branch } = await repository.state(root);
  if (!branch.head) return undefined;
  const records: string[] = [];
  for (const entry of [...status.conflicted, ...status.staged, ...status.unstaged]) {
    if (entry.submodule !== "N...") return undefined;
    records.push(
      `${entry.indexStatus}${entry.worktreeStatus}\0${entry.path}\0${entry.oldPath ?? ""}`,
    );
  }
  for (const path of status.untracked) records.push(`??\0${path}`);
  const paths = new Set(
    [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked].flatMap(
      (entry) =>
        typeof entry === "string"
          ? [entry]
          : entry.oldPath
            ? [entry.path, entry.oldPath]
            : [entry.path],
    ),
  );
  const hash = createHash("sha256").update(branch.head).update("\0");
  for (const record of records.toSorted()) hash.update(record).update("\0");
  for (const path of [...paths].toSorted()) {
    const stats = await lstat(join(root, path), { bigint: true }).catch(() => undefined);
    if (stats?.isDirectory()) return undefined;
    hash
      .update(path)
      .update("\0")
      .update(
        stats
          ? `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}:${stats.mode}`
          : "missing",
      )
      .update("\0");
  }
  return hash.digest("hex");
}
