import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Thread } from "@ace/protocol";
import { ManagedWorktrees } from "../managed-worktrees.ts";
import { StorageService } from "./service.ts";
import { WorktreeBackups } from "./worktree-backups.ts";
import { WorktreeBatches } from "./worktree-batches.ts";
import { WorktreeIO } from "./worktree-io.ts";
import { git, worktreeFixture } from "./worktree-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test("automatic backup and deletion pass 257 protected checkouts and report a later failed push", async () => {
  const f = await worktreeFixture();
  cleanups.push(() => f.close());
  const day = 86400000;
  const entries = [{ path: f.path, thread: f.thread }];
  const managed = new ManagedWorktrees(f.store, f.root);
  // Use actual Git creation and the same provenance recorder as prepareCreation.
  // No managed record or filesystem identity is fabricated for this scale fixture.
  for (let i = 0; i < 257; i++) {
    const id = `batch-${String(i).padStart(3, "0")}`;
    const path = join(f.root, "worktrees", id);
    await f.edge.createWorktree({ repo: f.repo, path, branch: id, baseRef: "main" });
    const thread = Thread.parse({
      ...f.thread,
      id,
      details: { mode: "worktree", worktree: path, branch: id },
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
    await managed.created(f.edge, f.repo, path, thread.id, f.now());
    entries.push({ path, thread });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const target = entries.at(-1);
  const first = entries[0];
  if (!target || !first) throw new Error("Missing batch targets");
  for (const entry of entries) {
    f.store.appendEvents(
      entry.thread.id,
      [
        {
          type: "thread.client.updated",
          changes: { settledAt: f.now() - 10 * day, pinned: entry !== target },
        },
      ],
      f.now() - 10 * day,
    );
  }
  const remote = join(f.root, "origin.git");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(f.repo, "remote", "add", "origin", remote);
  await git(f.repo, "push", "origin", "main");
  await git(f.repo, "config", "user.name", "Test");
  await git(f.repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(target.path, "later.txt"), "later work\n");
  const io = new WorktreeIO({ transportProtocols: ["file"] });
  cleanups.push(() => io.close());
  let sequence = 0;
  const owner = {
    root: f.root,
    store: f.store,
    services: f.services,
    now: f.now,
    id: () => `batch-plan-${++sequence}`,
    worktrees: io,
  };
  const storage = new StorageService(owner);
  cleanups.push(() => storage.close());

  await storage.backupWorktrees(() => true);
  await storage.cleanupWorktrees(1, () => true);
  expect(await git(target.path, "status", "--porcelain")).toContain("later.txt");
  await access(target.path);

  // Cursor objects are daemon-local. Reading the managed inventory never consumes them.
  const cursor = new WorktreeBatches();
  const independent = new WorktreeBatches();
  expect(cursor.next(managed).map((record) => record.path)).toEqual(
    entries.slice(0, 256).map((entry) => entry.path),
  );
  managed.list();
  expect(independent.next(managed).map((record) => record.path)).toEqual(
    entries.slice(0, 256).map((entry) => entry.path),
  );
  expect(cursor.next(managed).map((record) => record.path)).toEqual(
    entries.slice(256).map((entry) => entry.path),
  );

  // Persisted successful outcomes can fill the public result budget. These are outcome
  // fixtures only: every joined managed record above has real creation provenance.
  for (const entry of entries.slice(0, 256)) {
    f.store
      .statement("INSERT INTO storage_worktree_backups VALUES (?,?)")
      .run(entry.path, JSON.stringify({ path: entry.path, state: "complete", updatedAt: f.now() }));
  }
  await git(f.repo, "remote", "set-url", "origin", join(f.root, "missing.git"));
  await storage.backupWorktrees(() => true);
  // This public result is the bounded backup list returned by Storage usage.
  const results = new WorktreeBackups(owner).results();
  expect(results).toHaveLength(256);
  expect(results?.[0]).toMatchObject({ path: target.path, state: "failed" });
  await access(target.path);
  await git(f.repo, "remote", "set-url", "origin", remote);
  // A failed backup is retried after the cursor wraps past the protected prefix.
  await storage.backupWorktrees(() => true);
  await storage.backupWorktrees(() => true);
  const branch = await git(target.path, "branch", "--show-current");
  expect(await git(remote, "show", `${branch}:later.txt`)).toBe("later work");
  expect(await git(target.path, "status", "--porcelain")).toBe("");
  // Successful backup alone never authorizes deletion of an unmerged topic branch.
  await storage.cleanupWorktrees(1, () => true);
  await access(target.path);
  await git(
    f.repo,
    "update-ref",
    "refs/remotes/origin/main",
    await git(target.path, "rev-parse", "HEAD"),
  );

  // The cleanup cursor wrapped after its tail page. It must reach the tail again.
  await storage.cleanupWorktrees(1, () => true);
  await access(target.path);
  await storage.cleanupWorktrees(1, () => true);
  await expect(access(target.path)).rejects.toMatchObject({ code: "ENOENT" });
  await access(first.path);
  // Earlier protections are revisited on the next cycle even after a later row disappears.
  f.store.appendEvents(
    first.thread.id,
    [{ type: "thread.client.updated", changes: { pinned: false } }],
    f.now() - 10 * day,
  );
  await storage.cleanupWorktrees(1, () => true);
  await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(f.repo, "status", "--porcelain")).toBe("");
}, 300000);
