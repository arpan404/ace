import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { repository, put, scalar, git, scratch } from "./test-repo.ts";
import { join } from "node:path";

test("commit stages changed files with the requested message and rejects stale HEAD without staging", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    const original = await scalar(root, "rev-parse", "HEAD");
    await put(root, "tracked.txt", "changed\n");
    await expect(
      service.commit({ worktree: root, expectedHead: "a".repeat(40), message: "Stale" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await scalar(root, "diff", "--cached", "--name-only")).toBe("");
    const head = await service.commit({
      worktree: root,
      expectedHead: original,
      message: "Commit from client\n\nBody with `literal` characters",
    });
    expect(head).not.toBe(original);
    expect(await scalar(root, "log", "-1", "--format=%B")).toBe(
      "Commit from client\n\nBody with `literal` characters\n",
    );
    expect(await scalar(root, "show", "HEAD:tracked.txt")).toBe("changed");
    expect(await scalar(root, "status", "--porcelain")).toBe("");
  } finally {
    await service.close();
  }
});

test("push updates an existing remote branch and refuses detached HEAD", async () => {
  const root = await repository();
  const remote = join(await scratch(), "remote.git");
  const service = new GitService();
  try {
    await git(root, "init", "--bare", remote);
    await git(root, "remote", "add", "origin", remote);
    const info = await service.repositoryInfo(root);
    if (!info.branch) throw new Error("Expected branch");
    await service.push({ worktree: root, remote: "origin" });
    expect(await scalar(remote, "rev-parse", `refs/heads/${info.branch}`)).toBe(info.head);
    expect((await service.repositoryInfo(root)).upstream).toBe(`origin/${info.branch}`);
    await git(root, "checkout", "--detach", "HEAD");
    await expect(service.push({ worktree: root, remote: "origin" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  } finally {
    await service.close();
  }
});
