import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

const service = new GitService();

test("repository info reports root, branch, HEAD, remotes and upstream divergence", async () => {
  const repo = await repository();
  const initial = await scalar(repo, "rev-parse", "HEAD");
  await git(repo, "remote", "add", "origin", "https://example.invalid/雪 repo.git");
  await git(
    repo,
    "config",
    "--add",
    "remote.origin.pushurl",
    "ssh://example.invalid/push repo.git",
  );
  await git(repo, "config", "--add", "remote.origin.pushurl", "ssh://example.invalid/second.git");
  await git(repo, "update-ref", "refs/remotes/origin/main", initial);
  await git(repo, "branch", "--set-upstream-to=origin/main", "main");
  await put(repo, "tracked.txt", "local\n");
  await git(repo, "commit", "-am", "Local commit");
  const local = await scalar(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-c", "upstream-side", initial);
  await put(repo, "remote.txt", "remote\n");
  await git(repo, "add", "remote.txt");
  await git(repo, "commit", "-m", "Remote commit");
  await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(repo, "switch", "main");
  const index = await readFile(join(repo, ".git", "index"));
  const info = await service.repositoryInfo(join(repo, ".git", ".."));
  expect(info).toEqual({
    root: repo,
    branch: "main",
    head: local,
    detached: false,
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
    remotes: [
      {
        name: "origin",
        fetchUrls: ["https://example.invalid/雪 repo.git"],
        pushUrls: ["ssh://example.invalid/push repo.git", "ssh://example.invalid/second.git"],
      },
    ],
  });
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  await git(repo, "switch", "--detach", initial);
  expect(await service.repositoryInfo(repo)).toMatchObject({
    branch: null,
    detached: true,
    head: initial,
    upstream: null,
    ahead: 0,
    behind: 0,
  });
});

test("status separates staged and unstaged changes, untracked files and staged renames", async () => {
  const repo = await repository({ "two states.txt": "original\n", "old\n雪.txt": "rename\n" });
  await put(repo, "two states.txt", "staged\n");
  await git(repo, "add", "two states.txt");
  await put(repo, "two states.txt", "unstaged\n");
  await rename(join(repo, "old\n雪.txt"), join(repo, "new\n☃.txt"));
  await git(repo, "add", "--all");
  await put(repo, "two states.txt", "unstaged again\n");
  await put(repo, "untracked directory/ a\n雪.txt", "new\n");
  const state = await service.status(repo);
  expect(state.staged).toEqual(
    expect.arrayContaining([
      { path: "two states.txt", indexStatus: "M", worktreeStatus: "M", submodule: "N..." },
      {
        path: "new\n☃.txt",
        oldPath: "old\n雪.txt",
        indexStatus: "R",
        worktreeStatus: ".",
        submodule: "N...",
      },
    ]),
  );
  expect(state.staged).toHaveLength(2);
  expect(state.unstaged).toEqual([
    { path: "two states.txt", indexStatus: "M", worktreeStatus: "M", submodule: "N..." },
  ]);
  expect(state.untracked).toEqual(["untracked directory/ a\n雪.txt"]);
  expect(state.conflicted).toEqual([]);
});

test("conflicted files remain conflicted after snapshotting their working contents", async () => {
  const repo = await repository({ "conflict\n雪.txt": "base\n" });
  await git(repo, "switch", "-c", "side");
  await put(repo, "conflict\n雪.txt", "side\n");
  await git(repo, "commit", "-am", "Side");
  await git(repo, "switch", "main");
  await put(repo, "conflict\n雪.txt", "main\n");
  await git(repo, "commit", "-am", "Main");
  await expect(git(repo, "merge", "side")).rejects.toMatchObject({ code: 1 });
  const before = await readFile(join(repo, ".git", "index"));
  const content = await readFile(join(repo, "conflict\n雪.txt"));
  expect((await service.status(repo)).conflicted).toEqual([
    { path: "conflict\n雪.txt", indexStatus: "U", worktreeStatus: "U", submodule: "N..." },
  ]);
  const checkpoint = await service.createCheckpoint({
    worktree: repo,
    threadId: "merge",
    label: "conflict contents",
  });
  expect(await git(repo, "show", `${checkpoint.sha}:conflict\n雪.txt`)).toEqual(content);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(before);
  expect((await service.status(repo)).conflicted).toHaveLength(1);
});

test("missing repositories and git binaries fail clearly", async () => {
  const directory = await scratch();
  await expect(service.repositoryInfo(directory)).rejects.toMatchObject({ code: "not_a_repo" });
  await expect(service.repositoryInfo(join(directory, "absent"))).rejects.toMatchObject({
    code: "not_a_repo",
  });
  await expect(
    new GitService({ gitBinary: join(directory, "missing-git") }).repositoryInfo(directory),
  ).rejects.toMatchObject({ code: "git_missing" });
});

test("configured Git binaries enforce the version floor and kill hung calls", async () => {
  const directory = await scratch();
  const binary = join(directory, "fake git 雪");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write('git version 2.39.9\\n');\n`,
  );
  await chmod(binary, 0o755);
  await expect(
    new GitService({ gitBinary: binary }).repositoryInfo(directory),
  ).rejects.toMatchObject({ code: "git_too_old" });
  await writeFile(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('--version')) process.stdout.write('git version 2.40.0\\n'); else setInterval(() => {}, 1000);\n`,
  );
  await expect(
    new GitService({ gitBinary: binary, timeoutMs: 1_000 }).repositoryInfo(directory),
  ).rejects.toMatchObject({ code: "git_timeout" });
  expect(() => new GitService({ timeoutMs: 0 })).toThrow(
    expect.objectContaining({ code: "invalid_argument" }),
  );
});

test("every Git process disables prompts, uses C locale and disables optional locks for reads", async () => {
  const repo = await repository();
  const directory = await scratch();
  const binary = join(directory, "git with spaces 雪");
  await writeFile(
    binary,
    `#!${process.execPath}
    const { spawn } = require('node:child_process');
    const args = process.argv.slice(2);
    if (process.env.GIT_TERMINAL_PROMPT !== '0' || process.env.LC_ALL !== 'C') process.exit(71);
    const read = ['--version', 'rev-parse', 'config', 'status', 'ls-files', 'ls-tree', 'show', 'show-ref', 'for-each-ref'].some(arg => args.includes(arg)) || (args.includes('worktree') && args.includes('list'));
    if (read && process.env.GIT_OPTIONAL_LOCKS !== '0') process.exit(72);
    const child = spawn('git', args, {stdio: 'inherit', shell: false});
    child.on('error', () => process.exit(73));
    child.on('close', code => process.exit(code ?? 74));
  `,
  );
  await chmod(binary, 0o755);
  const configured = new GitService({ gitBinary: binary });
  const checkpoint = await configured.createCheckpoint({
    worktree: repo,
    threadId: "environment",
    label: "environment",
  });
  expect(await configured.repositoryInfo(repo)).toMatchObject({ branch: "main" });
  expect(await configured.status(repo)).toEqual({
    staged: [],
    unstaged: [],
    conflicted: [],
    untracked: [],
  });
  expect(await configured.listCheckpoints({ repo, threadId: "environment" })).toEqual([checkpoint]);
});

test("temporary-index filesystem failures return typed errors without changing the user index", async () => {
  const repo = await repository();
  const index = await readFile(join(repo, ".git", "index"));
  const directory = await scratch();
  const oldTemp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = join(directory, "missing-temp-directory");
    await expect(
      new GitService().createCheckpoint({ worktree: repo, threadId: "io", label: "io" }),
    ).rejects.toMatchObject({ code: "filesystem_error", details: { errno: "ENOENT" } });
  } finally {
    if (oldTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTemp;
  }
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  expect(await service.listCheckpoints({ repo, threadId: "io" })).toEqual([]);
});

test("inherited repository and index selectors cannot redirect checkpoint writes", async () => {
  const repo = await repository();
  const other = await repository({ "other.txt": "other repo\n" });
  const otherIndex = await readFile(join(other, ".git", "index"));
  const oldDir = process.env.GIT_DIR;
  const oldIndex = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_INDEX_FILE = join(other, ".git", "index");
    const checkpoint = await new GitService().createCheckpoint({
      worktree: repo,
      threadId: "isolation",
      label: "isolation",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:tracked.txt`)).toString()).toBe(
      "original\n",
    );
    expect(await readFile(join(other, ".git", "index"))).toEqual(otherIndex);
    expect(await scalar(other, "for-each-ref", "--format=%(refname)", "refs/ace/")).toBe("");
  } finally {
    if (oldDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldDir;
    if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = oldIndex;
  }
});
