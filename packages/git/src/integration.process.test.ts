import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

test("an integration receipt returns the same immutable revision after replay without another merge", async () => {
  const service = new GitService();
  try {
    const repo = await repository();
    const base = await scalar(repo, "rev-parse", "HEAD");
    const worker = join(dirname(repo), "card");
    await service.createWorktree({ repo, path: worker, baseRef: base, branch: "work/card" });
    await put(worker, "card.txt", "card works\n");
    await git(worker, "add", "card.txt");
    await git(worker, "commit", "-m", "card");
    const revision = await scalar(worker, "rev-parse", "HEAD");
    const first = await service.integrate({ worktree: repo, revision, key: "card.integration" });
    expect(first.conflict).toBeNull();
    expect(await scalar(repo, "show", "HEAD:card.txt")).toBe("card works");
    const replay = await service.integrate({ worktree: repo, revision, key: "card.integration" });
    expect(replay.revision).toBe(first.revision);
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(first.revision);
    // Crash after merge but before the receipt: ancestry recovers the existing merge.
    await git(repo, "update-ref", "-d", "refs/ace/conductor/card.integration");
    const recovered = await service.integrate({
      worktree: repo,
      revision,
      key: "card.integration",
    });
    expect(recovered.revision).toBe(first.revision);
  } finally {
    await service.close();
  }
});
test("conflicting integration leaves the private branch at its original clean revision", async () => {
  const service = new GitService();
  try {
    const repo = await repository();
    const base = await scalar(repo, "rev-parse", "HEAD");
    const worker = join(dirname(repo), "card");
    await service.createWorktree({ repo, path: worker, baseRef: base, branch: "work/card" });
    await put(worker, "tracked.txt", "worker\n");
    await git(worker, "commit", "-am", "worker");
    const revision = await scalar(worker, "rev-parse", "HEAD");
    await put(repo, "tracked.txt", "integration\n");
    await git(repo, "commit", "-am", "integration");
    const head = await scalar(repo, "rev-parse", "HEAD");
    const result = await service.integrate({ worktree: repo, revision, key: "conflict" });
    expect(result.conflict).toBeTruthy();
    expect(await scalar(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await scalar(repo, "status", "--porcelain")).toBe("");
  } finally {
    await service.close();
  }
});
