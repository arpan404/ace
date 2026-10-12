import { realpathSync, lstatSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { PinnedDirectory } from "@ace/workspace";
import { ThreadId } from "@ace/protocol";
import type { GitService } from "@ace/git";
import { z } from "zod";
import type { Store } from "./store.ts";

const Record = z.object({
  path: z.string(),
  repo: z.string(),
  owner: ThreadId,
  parent_dev: z.number(),
  parent_ino: z.number(),
  tree_dev: z.number(),
  tree_ino: z.number(),
  repo_dev: z.number(),
  repo_ino: z.number(),
  metadata_path: z.string(),
  metadata_dev: z.number(),
  metadata_ino: z.number(),
  created_at: z.number(),
  removed: z.number().int().min(0).max(1),
});
export type ManagedWorktree = z.infer<typeof Record>;
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Creation provenance is never inferred from a branch name, session cwd or directory listing. */
export class ManagedWorktrees {
  private store: Store;
  private root: string;
  constructor(store: Store, root: string) {
    this.store = store;
    this.root = root;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS managed_worktrees(
      path TEXT PRIMARY KEY,record TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0)`),
    );
  }
  list(): ManagedWorktree[] {
    return this.store
      .statement("SELECT record FROM managed_worktrees WHERE removed=0 ORDER BY path LIMIT 257")
      .all()
      .map((row) => Record.parse(JSON.parse(z.string().parse(row.record))));
  }
  get(path: string): ManagedWorktree | undefined {
    const row = this.store.statement("SELECT record FROM managed_worktrees WHERE path=?").get(path);
    return row ? Record.parse(JSON.parse(z.string().parse(row.record))) : undefined;
  }
  /** Called only after a successful, new GitService.createWorktree. Never on reuse/adoption. */
  async created(
    git: Pick<GitService, "worktreeMetadata">,
    repo: string,
    path: string,
    owner: ThreadId,
    at: number,
  ): Promise<void> {
    const parent = PinnedDirectory.atBoundary(join(this.root, "worktrees"));
    try {
      const name = relative(await realpath(join(this.root, "worktrees")), path);
      if (!name || name.includes(sep) || name === "..") throw new Error("unmanaged_worktree");
      const tree = parent.child(name);
      try {
        const metadata = await git.worktreeMetadata(repo, path);
        const canonicalRepo = await realpath(repo);
        const repository = await lstat(canonicalRepo);
        const row: ManagedWorktree = {
          path,
          repo: canonicalRepo,
          owner,
          parent_dev: parent.stat().dev,
          parent_ino: parent.stat().ino,
          tree_dev: tree.stat().dev,
          tree_ino: tree.stat().ino,
          repo_dev: repository.dev,
          repo_ino: repository.ino,
          metadata_path: metadata.path,
          metadata_dev: metadata.dev,
          metadata_ino: metadata.ino,
          created_at: at,
          removed: 0,
        };
        this.store.atomic(() =>
          this.store
            .statement("INSERT OR REPLACE INTO managed_worktrees VALUES (?,?,0)")
            .run(path, JSON.stringify(row)),
        );
      } finally {
        tree.closeSync();
      }
    } finally {
      parent.closeSync();
    }
  }
  /** Recheck both managed containment and original filesystem/Git administration identities. */
  verify(repo: string, path: string): ManagedWorktree | undefined {
    const row = this.get(path);
    if (!row || row.removed || row.repo !== repo) return undefined;
    const parentPath = join(this.root, "worktrees");
    const canonical = realpathSync(parentPath);
    const name = relative(canonical, path);
    if (!name || name.includes(sep) || name === ".." || resolve(path) !== join(canonical, name))
      return undefined;
    const parent = PinnedDirectory.atBoundary(parentPath);
    try {
      const p = parent.stat();
      if (p.dev !== row.parent_dev || p.ino !== row.parent_ino || !this.repositoryMatches(row))
        return undefined;
      try {
        const tree = parent.child(name);
        try {
          const info = tree.stat();
          if (
            info.dev !== row.tree_dev ||
            info.ino !== row.tree_ino ||
            tree.readText(".git", 8192).replace(/\n$/, "") !== `gitdir: ${row.metadata_path}`
          )
            return undefined;
        } finally {
          tree.closeSync();
        }
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const metadata = PinnedDirectory.atBoundary(row.metadata_path);
      try {
        const info = metadata.stat();
        if (
          info.dev !== row.metadata_dev ||
          info.ino !== row.metadata_ino ||
          metadata.readText("gitdir", 8192).replace(/\n$/, "") !== join(path, ".git")
        )
          return undefined;
      } finally {
        metadata.closeSync();
      }
      return row;
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    } finally {
      parent.closeSync();
    }
  }
  /** An accepted removal may have already deleted Git administration before restart. */
  repositoryMatches(row: ManagedWorktree): boolean {
    try {
      const repository = lstatSync(row.repo);
      return (
        !repository.isSymbolicLink() &&
        realpathSync(row.repo) === row.repo &&
        repository.dev === row.repo_dev &&
        repository.ino === row.repo_ino
      );
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  }
  removed(path: string): void {
    const row = this.get(path);
    if (!row) throw new Error("unmanaged_worktree");
    row.removed = 1;
    this.store
      .statement("UPDATE managed_worktrees SET removed=1,record=? WHERE path=?")
      .run(JSON.stringify(row), path);
  }
}
