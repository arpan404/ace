import { lstat, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch, proxyGit } from "./test-repo.ts";

const service = new GitService();

test.each(["--assume-unchanged", "--skip-worktree"])(
  "removal protects edits hidden by %s without changing the index",
  async (flag) => {
    const repo = await repository();
    const path = join(dirname(repo), "hidden-edit");
    await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "hidden" });
    await git(path, "update-index", flag, "tracked.txt");
    await put(path, "tracked.txt", "hidden contents\n");
    const indexPath = await scalar(
      path,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    );
    const index = await readFile(indexPath);
    await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
      code: "dirty_worktree",
    });
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("hidden contents\n");
    expect(await readFile(indexPath)).toEqual(index);
  },
);

test("worktree creation branches from the requested commit and refuses implicit branch reuse", async () => {
  const repo = await repository();
  const initial = await scalar(repo, "rev-parse", "HEAD");
  await put(repo, "tracked.txt", "later\n");
  await git(repo, "commit", "-am", "Later");
  const path = join(dirname(repo), "thread worktree\n雪");
  const created = await service.createWorktree({
    repo,
    path,
    baseRef: initial,
    branch: "thread/one",
  });
  expect(created).toMatchObject({ path, branch: "thread/one", head: initial, detached: false });
  expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("original\n");
  expect((await service.listWorktrees(repo)).map((tree) => tree.path)).toEqual([repo, path]);
  const checkpoint = await service.createCheckpoint({
    worktree: path,
    threadId: "linked",
    label: "linked",
  });
  expect(await service.listCheckpoints({ repo, threadId: "linked" })).toEqual([checkpoint]);
  await service.removeWorktree({ repo, path });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    service.createWorktree({ repo, path, baseRef: "HEAD", branch: "thread/one" }),
  ).rejects.toMatchObject({ code: "branch_exists" });
  const reused = await service.createWorktree({
    repo,
    path,
    baseRef: "HEAD",
    branch: "thread/one",
    reuseBranch: true,
  });
  expect(reused.head).toBe(initial);
  await expect(
    service.createWorktree({
      repo,
      path: join(dirname(repo), "invalid"),
      baseRef: "HEAD",
      branch: "../escape",
    }),
  ).rejects.toMatchObject({ code: "invalid_ref" });
});

test("dirty removal refuses staged, unstaged and untracked changes and force stays inside the registered root", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "dirty tree");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "dirty" });
  const outside = await scratch();
  await put(outside, "keep.txt", "outside\n");
  await put(path, "new\n雪.txt", "untracked\n");
  await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
    code: "dirty_worktree",
  });
  await git(path, "add", "--all");
  await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
    code: "dirty_worktree",
  });
  await git(path, "reset", "--hard", "HEAD");
  await put(path, "tracked.txt", "unstaged\n");
  await expect(service.removeWorktree({ repo, path })).rejects.toMatchObject({
    code: "dirty_worktree",
  });
  await symlink(outside, join(path, "outside link"));
  await service.removeWorktree({ repo, path, force: true });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("outside\n");
  expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
});

test("removal rejects the main tree, subdirectories and unrelated directories even with force", async () => {
  const repo = await repository();
  const unrelated = await scratch();
  await put(unrelated, "keep.txt", "keep\n");
  await expect(service.removeWorktree({ repo, path: repo, force: true })).rejects.toMatchObject({
    code: "main_worktree",
  });
  await expect(
    service.removeWorktree({ repo, path: unrelated, force: true }),
  ).rejects.toMatchObject({ code: "worktree_not_found" });
  await expect(
    service.removeWorktree({ repo, path: join(repo, ".git"), force: true }),
  ).rejects.toMatchObject({ code: "worktree_not_found" });
  expect(await readFile(join(unrelated, "keep.txt"), "utf8")).toBe("keep\n");
});

test("pruning removes stale registrations without touching remaining worktrees", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "stale\n雪");
  await service.createWorktree({ repo, path, baseRef: "HEAD", branch: "stale" });
  await rm(path, { recursive: true });
  const stale = (await service.listWorktrees(repo)).find((tree) => tree.path === path);
  expect(stale).toBeDefined();
  expect(stale && stale.prunable).toEqual(expect.any(String));
  await service.pruneWorktrees(repo);
  expect((await service.listWorktrees(repo)).map((tree) => tree.path)).toEqual([repo]);
  expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
});

test("a failure reading the newly created checkout rolls back its branch and worktree", async () => {
  const repo = await repository();
  const marker = join(await scratch(), "created");
  const binary = await proxyGit(`
    const marker = ${JSON.stringify(marker)};
    const op = args.indexOf('worktree');
    if (op >= 0 && args[op + 1] === 'add') {
      const result = spawnSync('git', args);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      if (result.status === 0) fs.writeFileSync(marker, 'created');
      process.exit(result.status ?? 70);
    }
    if (op >= 0 && args[op + 1] === 'list' && fs.existsSync(marker)) {
      fs.unlinkSync(marker); process.stdout.write('invalid\\0'); process.exit(0);
    }
  `);
  const controlled = new GitService({ gitBinary: binary });
  const path = join(dirname(repo), "uncommitted-creation");
  const before = await scalar(repo, "for-each-ref", "refs/heads", "--format=%(refname)");
  try {
    await expect(
      controlled.createWorktree({ repo, path, branch: "ace/failure", baseRef: "HEAD" }),
    ).rejects.toMatchObject({ code: "malformed_output" });
    expect((await service.listWorktrees(repo)).map((tree) => tree.path)).toEqual([repo]);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await scalar(repo, "for-each-ref", "refs/heads", "--format=%(refname)")).toBe(before);
  } finally {
    await controlled.close();
  }
});
