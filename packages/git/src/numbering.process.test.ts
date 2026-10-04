import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { spawnGitProcess } from "./process-runtime.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

test("checkpoint numbering survives service restarts and deletion releases all thread refs", async () => {
  const repo = await repository();
  const first = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "restart",
    label: "first",
  });
  const second = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "restart",
    label: "second",
  });
  expect(second.sequence).toBe(first.sequence + 1);
  expect(await new GitService().listCheckpoints({ repo, threadId: "restart" })).toEqual([
    first,
    second,
  ]);
  expect(await scalar(repo, "rev-parse", "refs/ace/checkpoint-sequences/restart")).toBe(second.sha);
  expect(await new GitService().deleteCheckpoints({ repo, threadId: "restart" })).toEqual({
    deleted: 2,
  });
  expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
  expect(
    (await new GitService().createCheckpoint({ worktree: repo, threadId: "restart", label: "new" }))
      .sequence,
  ).toBe(1);
});

test("legacy refs migrate once and keep numeric ordering and metadata", async () => {
  const repo = await repository();
  const tree = await scalar(repo, "rev-parse", "HEAD^{tree}");
  const message = JSON.stringify({
    format: "ace-checkpoint-v1",
    threadId: "legacy",
    label: "old",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  const old = await scalar(repo, "commit-tree", tree, "-m", message);
  await git(repo, "update-ref", "refs/ace/checkpoints/legacy/12", old);
  await git(repo, "update-ref", "refs/ace/checkpoints/legacy/2", old);
  const next = await new GitService().createCheckpoint({
    worktree: repo,
    threadId: "legacy",
    label: "new",
  });
  expect(next.sequence).toBe(13);
  expect(
    (await new GitService().listCheckpoints({ repo, threadId: "legacy" })).map((c) => [
      c.sequence,
      c.label,
    ]),
  ).toEqual([
    [2, "old"],
    [12, "old"],
    [13, "new"],
  ]);
  expect(
    (
      await new GitService().createCheckpoint({
        worktree: repo,
        threadId: "legacy",
        label: "restart",
      })
    ).sequence,
  ).toBe(14);
});

test("independent worktree allocations atomically advance the shared thread counter", async () => {
  const repo = await repository();
  const path = join(await scratch(), "linked");
  await new GitService().createWorktree({ repo, path, baseRef: "HEAD", branch: "linked" });
  const checkpoints = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new GitService().createCheckpoint({
        worktree: i % 2 ? path : repo,
        threadId: "shared",
        label: String(i),
      }),
    ),
  );
  expect(checkpoints.map((c) => c.sequence).toSorted((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(
    (await new GitService().listCheckpoints({ repo, threadId: "shared" })).map((c) => c.id),
  ).toEqual(checkpoints.toSorted((a, b) => a.sequence - b.sequence).map((c) => c.id));
});

test("SHA-256 repositories retain full hashes through status, checkpoints, diffs and restore", async () => {
  const repo = await scratch();
  await git(repo, "init", "--object-format=sha256", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await put(repo, "file\n雪.txt", "before\n");
  await git(repo, "add", "--all");
  await git(repo, "commit", "-m", "Initial");
  const service = new GitService();
  const saved = await service.createCheckpoint({
    worktree: repo,
    threadId: "sha256",
    label: "before",
  });
  expect(saved.sha).toMatch(/^[a-f0-9]{64}$/);
  expect(saved.tree).toMatch(/^[a-f0-9]{64}$/);
  expect((await service.repositoryInfo(repo)).head).toHaveLength(64);
  await put(repo, "file\n雪.txt", "after\n");
  expect(
    (
      await service.diff({
        worktree: repo,
        from: { kind: "checkpoint", id: saved.id },
        to: { kind: "working-tree" },
      })
    ).patch,
  ).toContain("-before\n+after");
  await service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id });
  expect(
    (await service.createCheckpoint({ worktree: repo, threadId: "sha256", label: "after" })).tree,
  ).toBe(saved.tree);
});

test("checkpoint allocation retries a transient ref lock before its competing writer commits", async () => {
  const repo = await repository();
  const lock = join(repo, ".git/refs/ace/checkpoint-sequences/retry.lock");
  // Seed the parent ref directory through the public operation.
  await new GitService().createCheckpoint({ worktree: repo, threadId: "retry", label: "seed" });
  let blocked = false;
  const service = new GitService({
    now: () => new Date("2026-10-03T00:00:00.000Z"),
    processRuntime: {
      spawn(command, args, options) {
        const collision = args.includes("update-ref") && args.includes("--stdin") && !blocked;
        if (collision) {
          blocked = true;
          writeFileSync(lock, "competing transaction");
        }
        const child = spawnGitProcess(command, args, options);
        if (collision) child.once("close", () => unlinkSync(lock));
        return child;
      },
    },
  });
  const checkpoint = await service.createCheckpoint({
    worktree: repo,
    threadId: "retry",
    label: "after lock",
  });
  expect(checkpoint.sequence).toBe(2);
  expect(
    (await service.listCheckpoints({ repo, threadId: "retry" })).map((entry) => entry.label),
  ).toEqual(["seed", "after lock"]);
});

test("a stale checkpoint lock backs off and reports Git's lock diagnostic when its budget expires", async () => {
  const repo = await repository();
  await new GitService().createCheckpoint({ worktree: repo, threadId: "stale", label: "seed" });
  const lock = join(repo, ".git/refs/ace/checkpoint-sequences/stale.lock");
  writeFileSync(lock, "stale transaction");
  type Timer = { delay: number; run(): void };
  let timer = Promise.withResolvers<Timer>();
  const service = new GitService({
    processRuntime: {
      scheduleTimeout(callback, delay) {
        if (delay <= 250) {
          timer.resolve({ delay, run: callback });
          return () => {};
        }
        const deadline = setTimeout(callback, delay);
        return () => clearTimeout(deadline);
      },
    },
  });
  try {
    const creating = service.createCheckpoint({
      worktree: repo,
      threadId: "stale",
      label: "blocked",
    });
    const failed = expect(creating).rejects.toMatchObject({
      code: "git_failed",
      message: expect.stringContaining("stale.lock"),
    });
    for (let attempt = 0; attempt < 19; attempt++) {
      const next = await timer.promise;
      expect(next.delay).toBe(Math.min(250, 25 * (attempt + 1)));
      timer = Promise.withResolvers<Timer>();
      next.run();
    }
    await failed;
    expect(
      (await service.listCheckpoints({ repo, threadId: "stale" })).map((entry) => entry.label),
    ).toEqual(["seed"]);
  } finally {
    unlinkSync(lock);
    await service.close();
  }
});
