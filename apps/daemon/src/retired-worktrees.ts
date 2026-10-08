import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { GitService, type GitOptions } from "@ace/git";
import type { Store } from "./store.ts";

const upgrade = "remove-offshift-2026-10-07";

/** One upgrade pass. Git owns deletion and refuses dirty, locked or quarantined trees. */
export async function cleanRetiredWorktrees(
  store: Store,
  directory: string,
  options: GitOptions,
  retained: (path: string, error: unknown) => void,
): Promise<void> {
  if (store.statement("SELECT id FROM upgrade_cleanup WHERE id=?").get(upgrade)) return;
  const root = join(directory, "deck-worktrees");
  let entries;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      retained(root, new Error("Upgrade directory is not a physical directory"));
      return;
    }
    entries = await opendir(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      retained(root, error);
      return;
    }
  }
  const git = new GitService(options);
  try {
    try {
      if (entries)
        for await (const entry of entries) {
          const path = join(root, entry.name);
          try {
            const info = await lstat(path);
            if (!info.isDirectory() || info.isSymbolicLink())
              throw new Error("Retained entry is not a physical worktree directory");
            await git.removeWorktree({ repo: path, path });
          } catch (error) {
            retained(path, error);
          }
        }
    } catch (error) {
      retained(root, error);
      return;
    }
    store.atomic((db) =>
      db.prepare("INSERT OR IGNORE INTO upgrade_cleanup VALUES (?)").run(upgrade),
    );
  } finally {
    await git.close();
  }
}
