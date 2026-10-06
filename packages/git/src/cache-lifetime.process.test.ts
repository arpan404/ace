import { expect, it, onTestFinished } from "vitest";
import { GitService, spawnGitProcess, type GitProcessRuntime } from "./index.ts";
import { git, repository, scalar } from "./test-repo.ts";

function ownedService(capacity?: number): GitService {
  const result = new GitService(
    capacity === undefined ? {} : { checkpointCounterCacheSize: capacity },
  );
  onTestFinished(() => result.close());
  return result;
}

it("evicted checkpoint counters reload durable sequences without growing the cache", async () => {
  const root = await repository();
  const service = new GitService({ checkpointCounterCacheSize: 2 });
  try {
    const first = await service.createCheckpoint({
      worktree: root,
      threadId: "first",
      label: "one",
    });
    for (const threadId of ["second", "third"])
      await service.createCheckpoint({ worktree: root, threadId, label: threadId });
    expect(service.resourceUsage().checkpointCounters).toBeLessThanOrEqual(2);
    const next = await service.createCheckpoint({
      worktree: root,
      threadId: "first",
      label: "two",
    });
    expect(next.sequence).toBe(first.sequence + 1);
    expect(next.id).not.toBe(first.id);
    expect(
      (await service.listCheckpoints({ repo: root, threadId: "first" })).map((c) => c.id),
    ).toEqual([first.id, next.id]);
    expect(service.resourceUsage().checkpointCounters).toBeLessThanOrEqual(2);
  } finally {
    await service.close();
  }
});

it("distinct roots and threads share the default retention budget and recover independent sequences", async () => {
  const roots = [await repository(), await repository()];
  const bounded = ownedService();
  for (const root of roots) {
    for (let index = 0; index < 70; index++) {
      const saved = await bounded.createCheckpoint({
        worktree: root,
        threadId: `thread_${index}`,
        label: root,
      });
      expect(saved.sequence).toBe(1);
      expect(bounded.resourceUsage().checkpointCounters).toBeLessThanOrEqual(128);
    }
  }
  // The oldest root/thread pair is evicted, while the same thread in the other
  // repository has its own counter. Neither loses its durable checkpoint.
  for (const root of roots) {
    const saved = await bounded.createCheckpoint({
      worktree: root,
      threadId: "thread_0",
      label: "revisited",
    });
    expect(saved.sequence).toBe(2);
    expect(
      (await bounded.listCheckpoints({ repo: root, threadId: "thread_0" })).map((c) => c.label),
    ).toEqual([root, "revisited"]);
  }
});

it("durable recovery works after eviction and restart with checkpoint history unavailable", async () => {
  const root = await repository();
  let scansAllowed = true;
  const runtime: Pick<GitProcessRuntime, "spawn"> = {
    spawn(command, args, options) {
      // Real Git remains the edge. Make historical enumeration unavailable
      // after migration, so success proves allocation needs only the counter.
      if (!scansAllowed && args.includes("for-each-ref"))
        return spawnGitProcess(command, ["ace-history-unavailable"], options);
      return spawnGitProcess(command, args, options);
    },
  };
  const bounded = new GitService({ checkpointCounterCacheSize: 1, processRuntime: runtime });
  onTestFinished(() => bounded.close());
  const tree = await scalar(root, "rev-parse", "HEAD^{tree}");
  const sha = await scalar(
    root,
    "commit-tree",
    tree,
    "-m",
    JSON.stringify({
      format: "ace-checkpoint-v1",
      threadId: "legacy",
      label: "legacy",
      createdAt: "2025-01-01T00:00:00.000Z",
    }),
  );
  await git(root, "update-ref", "refs/ace/checkpoints/legacy/12", sha);
  expect(
    (await bounded.createCheckpoint({ worktree: root, threadId: "legacy", label: "migrated" }))
      .sequence,
  ).toBe(13);
  await bounded.createCheckpoint({ worktree: root, threadId: "other", label: "evict" });
  scansAllowed = false;
  for (const label of ["evicted", "warm"]) {
    const saved = await bounded.createCheckpoint({ worktree: root, threadId: "legacy", label });
    expect(saved.sequence).toBe(label === "evicted" ? 14 : 15);
  }
  await bounded.close();
  const restarted = new GitService({ checkpointCounterCacheSize: 1, processRuntime: runtime });
  onTestFinished(() => restarted.close());
  const saved = await restarted.createCheckpoint({
    worktree: root,
    threadId: "legacy",
    label: "restart",
  });
  expect(saved.sequence).toBe(16);
  scansAllowed = true;
  expect(
    (await restarted.listCheckpoints({ repo: root, threadId: "legacy" })).map((c) => c.sequence),
  ).toEqual([12, 13, 14, 15, 16]);
  expect(await scalar(root, "rev-parse", "refs/ace/checkpoint-sequences/legacy")).toBe(saved.sha);
});

it("recently allocated counters stay warm while older threads are evicted", async () => {
  const root = await repository();
  let hotReadsAllowed = true;
  const bounded = new GitService({
    checkpointCounterCacheSize: 2,
    processRuntime: {
      spawn(command, args, options) {
        if (
          !hotReadsAllowed &&
          args.includes("show") &&
          args.includes("refs/ace/checkpoint-sequences/hot")
        )
          return spawnGitProcess(command, ["ace-counter-read-unavailable"], options);
        return spawnGitProcess(command, args, options);
      },
    },
  });
  onTestFinished(() => bounded.close());
  await bounded.createCheckpoint({ worktree: root, threadId: "hot", label: "seed" });
  await bounded.createCheckpoint({ worktree: root, threadId: "old", label: "older" });
  hotReadsAllowed = false;
  for (let index = 0; index < 4; index++) {
    const saved = await bounded.createCheckpoint({
      worktree: root,
      threadId: "hot",
      label: `hot ${index}`,
    });
    expect(saved.sequence).toBe(index + 2);
    await bounded.createCheckpoint({ worktree: root, threadId: `new_${index}`, label: "churn" });
    expect(bounded.resourceUsage().checkpointCounters).toBe(2);
  }
  expect(
    (await bounded.createCheckpoint({ worktree: root, threadId: "old", label: "recovered" }))
      .sequence,
  ).toBe(2);
});

it("evicted and stale services resume a deleted thread at its recreated durable generation", async () => {
  const root = await repository();
  const evicted = ownedService(1);
  const stale = ownedService(1);
  const remover = ownedService(1);
  await evicted.createCheckpoint({ worktree: root, threadId: "reuse", label: "old one" });
  await stale.createCheckpoint({ worktree: root, threadId: "reuse", label: "old two" });
  await evicted.createCheckpoint({ worktree: root, threadId: "other", label: "evict" });
  expect(await remover.deleteCheckpoints({ repo: root, threadId: "reuse" })).toEqual({
    deleted: 2,
  });
  const recreated = await evicted.createCheckpoint({
    worktree: root,
    threadId: "reuse",
    label: "new one",
  });
  expect(recreated.sequence).toBe(1);
  const recovered = await stale.createCheckpoint({
    worktree: root,
    threadId: "reuse",
    label: "new two",
  });
  expect(recovered.sequence).toBe(2);
  expect(await remover.listCheckpoints({ repo: root, threadId: "reuse" })).toEqual([
    recreated,
    recovered,
  ]);
  expect(await remover.deleteCheckpoints({ repo: root, threadId: "reuse" })).toEqual({
    deleted: 2,
  });
  expect(
    (await remover.createCheckpoint({ worktree: root, threadId: "reuse", label: "again" }))
      .sequence,
  ).toBe(1);
});
