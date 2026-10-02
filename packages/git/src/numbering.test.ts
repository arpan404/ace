import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
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
}, 30_000);

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
