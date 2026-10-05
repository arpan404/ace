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
    ).rejects.toMatchObject({ code: "head_moved" });
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

test("changed files list exactly what git status reports, and a commit can take only some of them", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    await put(root, "tracked.txt", "changed\nand more\n");
    await put(root, "staged.txt", "staged\n");
    await git(root, "add", "staged.txt");
    await put(root, "notes *.md", "scratch\n");
    await put(root, ".gitignore", "ignored.log\n");
    await put(root, "ignored.log", "noise\n");
    const { files, truncated } = await service.changedFiles(root);
    expect(truncated).toBe(false);
    expect(files.map((file) => [file.path, file.status])).toEqual([
      [".gitignore", "modified"],
      ["notes *.md", "untracked"],
      ["staged.txt", "added"],
      ["tracked.txt", "modified"],
    ]);
    const porcelain = (await git(root, "status", "--porcelain", "-z"))
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => line.slice(3))
      .toSorted();
    expect(files.map((file) => file.path)).toEqual(porcelain);
    expect(files.find((file) => file.path === "tracked.txt")).toMatchObject({
      additions: 2,
      deletions: 1,
    });
    expect((await service.changedFiles(root, 2)).truncated).toBe(true);

    const before = await scalar(root, "rev-parse", "HEAD");
    await service.commit({
      worktree: root,
      expectedHead: before,
      message: "Only these",
      paths: ["tracked.txt", "notes *.md"],
    });
    expect(await scalar(root, "show", "--name-only", "--format=", "HEAD")).toBe(
      "notes *.md\ntracked.txt",
    );
    // What wasn't picked stays as it was: staged.txt still staged, .gitignore still modified.
    expect(
      (await service.changedFiles(root)).files.map((file) => [file.path, file.status]),
    ).toEqual([
      [".gitignore", "modified"],
      ["staged.txt", "added"],
    ]);
    await expect(
      service.commit({
        worktree: root,
        expectedHead: await scalar(root, "rev-parse", "HEAD"),
        message: "Nothing",
        paths: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
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

import { chmod } from "node:fs/promises";
import { proxyGit } from "./test-repo.ts";

test("a silent failing pre-commit hook reports a safe hook failure and preserves HEAD", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    const expectedHead = await scalar(root, "rev-parse", "HEAD");
    await put(root, "tracked.txt", "edited\n");
    await put(root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    await chmod(join(root, ".git/hooks/pre-commit"), 0o700);
    await expect(
      service.commit({ worktree: root, expectedHead, message: "Rejected" }),
    ).rejects.toMatchObject({ code: "hook_failed", message: "Git command failed" });
    expect(await scalar(root, "rev-parse", "HEAD")).toBe(expectedHead);
  } finally {
    await service.close();
  }
});

test.each([
  ["fatal: Authentication failed for https://token@example.org/private", "auth_failed"],
  ["fatal: private /home/user/repo failed", "git_failed"],
])("push classifies %s without publishing local diagnostics", async (diagnostic, code) => {
  const root = await repository();
  await git(root, "remote", "add", "origin", "https://example.org/repo");
  const binary = await proxyGit(
    `if (args.includes('push')) { process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(1); }`,
  );
  const service = new GitService({ gitBinary: binary });
  try {
    await expect(service.push({ worktree: root, remote: "origin" })).rejects.toMatchObject({
      code,
      message: "Git command failed",
      details: { code: 1 },
    });
  } finally {
    await service.close();
  }
});

test("branch switching rejects dirty files by default and carries them only with explicit permission", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    const branch = await scalar(root, "branch", "--show-current");
    await git(root, "branch", "feature");
    await put(root, "tracked.txt", "dirty\n");
    await expect(
      service.switchBranch({ worktree: root, branch: "feature", allowUncommitted: false }),
    ).rejects.toMatchObject({ code: "dirty_worktree" });
    expect(await scalar(root, "branch", "--show-current")).toBe(branch);
    await service.switchBranch({ worktree: root, branch: "feature", allowUncommitted: true });
    expect(await scalar(root, "branch", "--show-current")).toBe("feature");
    expect(await scalar(root, "diff", "--", "tracked.txt")).toContain("+dirty");
    await expect(
      service.switchBranch({ worktree: root, branch: "--force", allowUncommitted: true }),
    ).rejects.toMatchObject({ code: "invalid_ref" });
  } finally {
    await service.close();
  }
});

test("commit distinguishes unmerged files from a command failure without changing the index", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    const branch = await scalar(root, "branch", "--show-current");
    await git(root, "switch", "-c", "divergent");
    await put(root, "tracked.txt", "divergent\n");
    await git(root, "commit", "-am", "Divergent");
    await git(root, "switch", branch);
    await put(root, "tracked.txt", "main\n");
    await git(root, "commit", "-am", "Main");
    await expect(git(root, "merge", "divergent")).rejects.toThrow();
    const index = await git(root, "ls-files", "--unmerged");
    await expect(
      service.commit({
        worktree: root,
        expectedHead: await scalar(root, "rev-parse", "HEAD"),
        message: "Unresolved",
      }),
    ).rejects.toMatchObject({ code: "conflicts" });
    expect(await git(root, "ls-files", "--unmerged")).toEqual(index);
  } finally {
    await service.close();
  }
});

test("successful hook traces do not misclassify a subsequent command failure", async () => {
  const root = await repository();
  await put(root, "tracked.txt", "edited\n");
  const binary = await proxyGit(`if (args.includes('commit')) {
    process.stderr.write(JSON.stringify({event:'child_start',sid:'a',child_id:0,child_class:'hook',hook_name:'pre-commit'})+'\\n');
    process.stderr.write(JSON.stringify({event:'child_exit',sid:'a',child_id:0,code:0})+'\\n');
    process.stderr.write('fatal: unrelated command failure\\n'); process.exit(1);
  }`);
  const service = new GitService({ gitBinary: binary });
  try {
    await expect(
      service.commit({
        worktree: root,
        expectedHead: await scalar(root, "rev-parse", "HEAD"),
        message: "fail",
      }),
    ).rejects.toMatchObject({ code: "git_failed", message: "Git command failed" });
  } finally {
    await service.close();
  }
});

test("a noisy failing commit-msg hook remains a safe hook failure beyond the diagnostic capture budget", async () => {
  const root = await repository();
  const service = new GitService();
  try {
    const expectedHead = await scalar(root, "rev-parse", "HEAD");
    await put(root, "tracked.txt", "edited\n");
    await put(root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    await put(
      root,
      ".git/hooks/commit-msg",
      `#!${process.execPath}\nprocess.stderr.write('x'.repeat(100000), () => process.exit(1));\n`,
    );
    await chmod(join(root, ".git/hooks/pre-commit"), 0o700);
    await chmod(join(root, ".git/hooks/commit-msg"), 0o700);
    await expect(
      service.commit({ worktree: root, expectedHead, message: "fail" }),
    ).rejects.toMatchObject({ code: "hook_failed", message: "Git command failed" });
    expect(await scalar(root, "rev-parse", "HEAD")).toBe(expectedHead);
  } finally {
    await service.close();
  }
});
