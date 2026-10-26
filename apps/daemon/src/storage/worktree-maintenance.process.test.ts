import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StorageRetention, Thread } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { WorktreeMaintenance } from "./worktree-maintenance.ts";
import { StorageService } from "./service.ts";
import { WorktreeIO } from "./worktree-io.ts";
import { git, worktreeFixture } from "./worktree-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const day = 86400000;
async function setup() {
  const f = await worktreeFixture();
  cleanups.push(() => f.close());
  await f.storage.close();
  const io = new WorktreeIO({ transportProtocols: ["file"] });
  cleanups.push(() => io.close());
  let id = 0;
  const storage = new StorageService({
    root: f.root,
    store: f.store,
    services: f.services,
    now: f.now,
    id: () => `maintenance-${++id}`,
    worktrees: io,
  });
  cleanups.push(() => storage.close());
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "thread.updated", archivedAt: null },
      {
        type: "thread.client.updated",
        changes: { settledAt: f.now() - 10 * day },
      },
    ],
    f.now() - 10 * day,
  );
  return { ...f, storage, io };
}

test("a worker deletes an unchanged worktree by settlement age even when checkout files are recent", async () => {
  const f = await setup();
  await f.storage.cleanupWorktrees(7, () => true);
  await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.repo, "file.txt"), "utf8")).toBe("original\n");
  expect(f.store.getThread(f.thread.id)?.deletedAt).toBeUndefined();
});

test("automatic deletion waits for every owner's settlement age, live work and pins", async () => {
  const f = await setup();
  const child = Thread.parse({ ...f.thread, id: "child-owner", settledAt: f.now() - day });
  f.store.appendEvents(child.id, [{ type: "thread.created", thread: child }], f.now() - day);
  f.store.atomic((db) => {
    db.exec("CREATE TABLE delegation_participants(thread_id TEXT PRIMARY KEY,root_id TEXT)");
    const insert = db.prepare("INSERT INTO delegation_participants VALUES (?,?)");
    insert.run(f.thread.id, f.thread.id);
    insert.run(child.id, f.thread.id);
  });
  // The parent settled ten days ago, but its child's one-day window is authoritative.
  await f.storage.cleanupWorktrees(7, () => true);
  await access(f.path);
  f.store.appendEvents(
    child.id,
    [{ type: "thread.client.updated", changes: { settledAt: null } }],
    f.now() - 10 * day,
  );
  await f.storage.cleanupWorktrees(7, () => true);
  await access(f.path);
  f.store.appendEvents(
    child.id,
    [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      // Starting work normally clears settlement. Restore the old marker so live work,
      // independently of settlement age, is what protects this delegated owner.
      { type: "thread.client.updated", changes: { settledAt: f.now() - 10 * day } },
    ],
    f.now() - 10 * day,
  );
  await f.storage.cleanupWorktrees(7, () => true);
  await access(f.path);
  f.store.appendEvents(
    child.id,
    [
      { type: "thread.updated", status: { state: "done" } },
      {
        type: "thread.client.updated",
        changes: { settledAt: f.now() - 10 * day, pinned: true },
      },
    ],
    f.now() - 10 * day,
  );
  await f.storage.cleanupWorktrees(7, () => true);
  await access(f.path);
  f.store.appendEvents(
    child.id,
    [{ type: "thread.client.updated", changes: { pinned: false } }],
    f.now() - 10 * day,
  );
  await f.storage.cleanupWorktrees(7, () => true);
  await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("automatic deletion requires origin/main even when local main contains the worktree HEAD", async () => {
  const f = await setup();
  expect(await git(f.path, "rev-parse", "HEAD")).toBe(await git(f.repo, "rev-parse", "main"));
  await git(f.repo, "update-ref", "-d", "refs/remotes/origin/main");
  await f.storage.cleanupWorktrees(1, () => true);
  await access(f.path);
});

test("recently settled, unsettled, pinned and dirty worktrees survive automatic deletion", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { settledAt: f.now() - day } }],
    f.now() - day,
  );
  await f.storage.cleanupWorktrees(7, () => true);
  await access(f.path);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { settledAt: null } }],
    f.now(),
  );
  await f.storage.cleanupWorktrees(1, () => true);
  await access(f.path);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { settledAt: f.now() - 10 * day, pinned: true } }],
    f.now() - 10 * day,
  );
  await f.storage.cleanupWorktrees(1, () => true);
  await access(f.path);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { pinned: false } }],
    f.now() - 10 * day,
  );
  await writeFile(join(f.path, "file.txt"), "unfinished\n");
  await f.storage.cleanupWorktrees(1, () => true);
  expect(await readFile(join(f.path, "file.txt"), "utf8")).toBe("unfinished\n");
});

async function origin(f: Awaited<ReturnType<typeof setup>>) {
  const remote = join(f.root, "origin.git");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(f.repo, "remote", "add", "origin", remote);
  await git(f.repo, "push", "origin", "main");
  await git(f.repo, "config", "user.name", "Test");
  await git(f.repo, "config", "user.email", "test@example.invalid");
  return remote;
}

test("backup workers commit tracked and untracked files, exclude ignored files and push without deleting unmerged work", async () => {
  const f = await setup();
  const remote = await origin(f);
  await writeFile(join(f.path, "file.txt"), "backed up edit\n");
  await writeFile(join(f.path, "new.txt"), "new work\n");
  await writeFile(join(f.path, ".gitignore"), "ignored.txt\n");
  await writeFile(join(f.path, "ignored.txt"), "keep local\n");
  await f.storage.backupWorktrees(() => true);
  await f.storage.cleanupWorktrees(1, () => true);
  const branch = await git(f.path, "branch", "--show-current");
  expect(await git(remote, "show", `${branch}:file.txt`)).toBe("backed up edit");
  expect(await git(remote, "show", `${branch}:new.txt`)).toBe("new work");
  expect(await git(remote, "ls-tree", "--name-only", branch)).not.toContain("ignored.txt");
  expect(await git(f.path, "status", "--porcelain")).toBe("");
  expect(await readFile(join(f.path, "ignored.txt"), "utf8")).toBe("keep local\n");
  expect((await f.storage.usage()).backups).toMatchObject([{ path: f.path, state: "complete" }]);
  // The topic branch is published, but has changes outside main. Only merging makes it eligible.
  await access(f.path);
  await git(
    f.repo,
    "update-ref",
    "refs/remotes/origin/main",
    await git(f.path, "rev-parse", "HEAD"),
  );
  await f.storage.cleanupWorktrees(1, () => true);
  await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed push is visible, retains the backup commit and never deletes the worktree", async () => {
  const f = await setup();
  await origin(f);
  await git(f.repo, "remote", "set-url", "origin", join(f.root, "missing.git"));
  await writeFile(join(f.path, "new.txt"), "recoverable work\n");
  await f.storage.backupWorktrees(() => true);
  await f.storage.cleanupWorktrees(1, () => true);
  expect(await git(f.path, "show", "HEAD:new.txt")).toBe("recoverable work");
  expect((await f.storage.usage()).backups).toMatchObject([{ path: f.path, state: "failed" }]);
  await access(f.path);
});

test("the delete-all preview bypasses age, preserves live work and waits for apply", async () => {
  const f = await setup();
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { settledAt: f.now() } }],
    f.now(),
  );
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["worktrees"],
    forceItems: [],
    retention: StorageRetention.parse({ worktreeMode: "all_settled" }),
  });
  expect(plan.items).toMatchObject([{ disposition: "remove" }]);
  await access(f.path);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.client.updated", changes: { settledAt: null } }],
    f.now(),
  );
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("stale");
  await access(f.path);
});

test("a worker asks the daemon again before mutation and refuses withdrawn permission", async () => {
  const f = await setup();
  const state = await f.io.inspectWorktreeCleanup(f.repo, f.path);
  let checks = 0;
  await expect(
    f.io.cleanupWorktree(
      {
        repo: f.repo,
        path: f.path,
        fingerprint: state.fingerprint,
        force: false,
        removeBranch: false,
      },
      () => {
        // Admit the daemon call and the worker's initial check. Revoke only at
        // the final mutation dispatch, after Git inspection and lock acquisition.
        if (++checks > 2) throw new Error("permission withdrawn");
      },
    ),
  ).rejects.toMatchObject({ code: "head_moved" });
  await access(f.path);
});

test("saved worktree preferences schedule cleanup and disabling it withdraws the timer", async () => {
  const f = await setup();
  const settings = new SettingsService({ dataDir: f.root });
  f.services.settings = settings;
  cleanups.push(() => settings.close());
  const timers: { delay: number; work(): void }[] = [];
  const maintenance = new WorktreeMaintenance(
    { root: f.root, store: f.store, services: f.services, now: f.now, id: () => "unused" },
    f.storage,
    (delay, work) => {
      const timer = { delay, work };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    (error) => {
      throw error;
    },
  );
  cleanups.push(() => maintenance.close());
  await maintenance.start();
  expect(timers).toHaveLength(0);
  await settings.set("storage.worktreeRetentionDays", 1, { kind: "global" });
  await settings.settled({ kind: "global" });
  await expect.poll(() => timers.map((timer) => timer.delay)).toEqual([2000]);
  await settings.set("storage.worktreeRetentionDays", null, { kind: "global" });
  await settings.settled({ kind: "global" });
  await expect.poll(() => timers.length).toBe(0);
  await access(f.path);
  await settings.set("storage.worktreeRetentionDays", 1, { kind: "global" });
  await settings.settled({ kind: "global" });
  await expect.poll(() => timers.length).toBe(1);
  timers.shift()?.work();
  await expect
    .poll(
      async () =>
        access(f.path).then(
          () => false,
          () => true,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
});

test("daily storage cleanup cannot delete worktrees while their own automatic deletion is off", async () => {
  const f = await setup();
  await f.storage.scheduledCleanup();
  await access(f.path);
});
