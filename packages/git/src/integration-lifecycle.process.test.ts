import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

async function merged() {
  const repo = await repository({ "tracked.txt": "base\n" });
  const base = await scalar(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-c", "worker");
  await put(repo, "tracked.txt", "worker\n");
  await git(repo, "commit", "-am", "Worker change");
  const worker = await scalar(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "main");
  const service = new GitService();
  const merge = await service.integrate({ worktree: repo, revision: worker, key: "merge" });
  return { repo, base, service, revision: merge.revision };
}

test("rollback replay restores the prior tree once and retains unrelated earlier integrations", async () => {
  const h = await merged();
  try {
    const reverted = await h.service.rollbackIntegration({
      worktree: h.repo,
      revision: h.revision,
      key: "merge",
    });
    expect(await scalar(h.repo, "diff", h.base, "HEAD", "--")).toBe("");
    expect(
      await h.service.rollbackIntegration({ worktree: h.repo, revision: h.revision, key: "merge" }),
    ).toBe(reverted);
    expect(await scalar(h.repo, "rev-parse", "HEAD")).toBe(reverted);
  } finally {
    await h.service.close();
  }
});

test("rollback recovers an interrupted restore before its revert commit", async () => {
  const h = await merged();
  try {
    // Real Git state left by a crash after tree restoration, before the forward commit.
    await git(h.repo, "restore", `--source=${h.base}`, "--staged", "--worktree", "--", ".");
    await h.service.rollbackIntegration({ worktree: h.repo, revision: h.revision, key: "merge" });
    expect(await scalar(h.repo, "diff", h.base, "HEAD", "--")).toBe("");
    expect((await h.service.status(h.repo)).staged).toEqual([]);
  } finally {
    await h.service.close();
  }
});
