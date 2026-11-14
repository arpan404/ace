import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
  readdir,
  stat,
  readFile,
  chmod,
  lstat,
  readlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { GitService, type WorktreeProgress } from "./index.ts";

const git = promisify(execFile);
async function fixture(gitBinary?: string) {
  const home = await mkdtemp(join(tmpdir(), "ace-worktree-progress-"));
  const repo = join(home, "repo");
  await mkdir(repo);
  await git("git", ["init", "-b", "main", repo]);
  await Promise.all(
    Array.from({ length: 2048 }, (_, index) =>
      writeFile(join(repo, `file-${index}.txt`), `File ${index}\n`),
    ),
  );
  await git("git", ["-C", repo, "add", "."]);
  // A commit this size makes Git start a detached `maintenance run --auto`, whose repack writes
  // `.git/info/refs` seconds later and races the temp directory's removal. Keep setup inert.
  await git("git", [
    "-C",
    repo,
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Fixture",
  ]);
  return {
    home,
    repo,
    path: join(home, "tree"),
    service: new GitService(gitBinary ? { gitBinary } : {}),
  };
}

test("real file checkout reports ordered steps and increasing completed percentages", async () => {
  const f = await fixture();
  const progress: WorktreeProgress[] = [];
  try {
    await f.service.createWorktree({
      repo: f.repo,
      path: f.path,
      branch: "ace/test",
      baseRef: "main",
      onProgress: (value) => progress.push(value),
    });
    expect([...new Set(progress.map((value) => value.step))]).toEqual(["creating", "checking_out"]);
    const percentages = progress.flatMap((value) =>
      value.percent === undefined ? [] : [value.percent],
    );
    expect(percentages[0]).toBe(0);
    expect(percentages.at(-1)).toBe(100);
    expect(percentages.length).toBeGreaterThan(2);
    expect(
      percentages.every((value, index) => index === 0 || value > (percentages[index - 1] ?? -1)),
    ).toBe(true);
    await access(join(f.path, "file-2047.txt"));
    expect(await f.service.status(f.path)).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
  } finally {
    await f.service.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

/** Every file below `root` outside `.git`: bytes, symlink target and executable bit. */
async function files(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of await readdir(root, { recursive: true })) {
    if (name === ".git" || name.startsWith(`.git${sep}`)) continue;
    const info = await lstat(join(root, name));
    if (info.isSymbolicLink()) found.set(name, `link:${await readlink(join(root, name))}`);
    else if (info.isFile())
      found.set(
        name,
        `${info.mode & 0o100 ? "x" : "-"}:${await readFile(join(root, name), "hex")}`,
      );
  }
  return found;
}

test("a checkout written in batches has exactly the files a plain worktree add writes", async () => {
  const f = await fixture();
  try {
    // Enough paths for several batches, in nested folders, with a script and a link.
    await Promise.all(
      Array.from({ length: 3000 }, async (_, index) => {
        await mkdir(join(f.repo, `dir-${index % 7}`, `sub-${index % 3}`), { recursive: true });
        await writeFile(
          join(f.repo, `dir-${index % 7}`, `sub-${index % 3}`, `n-${index}`),
          `${index}\n`,
        );
      }),
    );
    // Paths reach checkout-index NUL-separated on stdin, so any name survives.
    await writeFile(join(f.repo, "雪 with spaces.txt"), "unicode\n");
    await writeFile(join(f.repo, "-starts-with-dash"), "dash\n");
    if (process.platform !== "win32") {
      await writeFile(join(f.repo, "line\nbreak\ttab.txt"), "control characters\n");
      await writeFile(join(f.repo, "run.sh"), "echo run\n");
      await chmod(join(f.repo, "run.sh"), 0o755);
      await symlink("run.sh", join(f.repo, "link"));
    }
    await git("git", ["-C", f.repo, "add", "."]);
    await git("git", [
      "-C",
      f.repo,
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "-qm",
      "More",
    ]);
    const plain = join(f.home, "plain");
    await git("git", ["-C", f.repo, "worktree", "add", "-q", "-b", "plain", plain]);
    const progress: number[] = [];
    await f.service.createWorktree({
      repo: f.repo,
      path: f.path,
      branch: "ace/batched",
      baseRef: "main",
      onProgress: (value) => {
        if (value.percent !== undefined) progress.push(value.percent);
      },
    });
    expect(await files(f.path)).toEqual(await files(plain));
    expect(progress.at(-1)).toBe(100);
    expect(await f.service.status(f.path)).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
  } finally {
    await f.service.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

test("cancelling after files have been written removes the partial checkout and its branch", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let written = false;
  try {
    await expect(
      f.service.createWorktree({
        repo: f.repo,
        path: f.path,
        branch: "ace/cancel",
        baseRef: "main",
        signal: controller.signal,
        onProgress(value) {
          if ((value.percent ?? 0) > 0) {
            written = true;
            controller.abort();
          }
        },
      }),
    ).rejects.toMatchObject({ code: "git_cancelled" });
    expect(written).toBe(true);
    expect(await f.service.listWorktrees(f.repo)).toHaveLength(1);
    expect(await f.service.branchHead({ repo: f.repo, branch: "ace/cancel" })).toBeUndefined();
    await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.service.mutationState(f.repo)).toMatchObject({ status: "available" });
  } finally {
    await f.service.close();
    await rm(f.home, { recursive: true, force: true });
  }
});

/** Every path under `root` with its size and modification time, to detect late writes. */
async function tree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const name of await readdir(root, { recursive: true })) {
    const info = await stat(join(root, name)).catch(() => undefined);
    if (info) entries.set(name, `${info.size}:${info.mtimeMs}`);
  }
  return entries;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("cancelling while a checkout batch is still writing waits for Git and leaves the repository settled", async () => {
  const scripts = await mkdtemp(join(tmpdir(), "ace-worktree-cancel-"));
  const log = join(scripts, "git.log");
  const busy = join(scripts, "busy");
  const binary = join(scripts, "git-slow.cjs");
  // Each checkout batch holds Git for a while so cancellation lands mid-write.
  await writeFile(
    binary,
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const slow = args.includes("checkout-index");
const run = () => {
  const child = spawn("git", args, { stdio: "inherit" });
  child.on("error", () => process.exit(70));
  child.on("close", (code) => {
    if (slow) fs.appendFileSync(${JSON.stringify(log)}, "end " + process.pid + " " + child.pid + "\\n");
    process.exit(code ?? 71);
  });
};
if (!slow) run();
else {
  fs.appendFileSync(${JSON.stringify(log)}, "start " + process.pid + "\\n");
  fs.writeFileSync(${JSON.stringify(busy)}, "");
  setTimeout(run, 400);
}
`,
  );
  await chmod(binary, 0o755);
  const f = await fixture(binary);
  const controller = new AbortController();
  try {
    const creation = f.service.createWorktree({
      repo: f.repo,
      path: f.path,
      branch: "ace/cancel-busy",
      baseRef: "main",
      signal: controller.signal,
      onProgress() {},
    });
    const settled = creation.catch((error: unknown) => error);
    for (let tries = 0; tries < 1000; tries++) {
      if (
        await access(busy).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    expect(await settled).toMatchObject({ code: "git_cancelled" });
    const before = await tree(join(f.repo, ".git"));

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.filter((line) => line.startsWith("start ")).length).toBeGreaterThan(0);
    // No Git process from the operation, nor the wrapper leading it, outlives the rejection.
    const pids = lines.flatMap((line) => line.split(" ").slice(1).map(Number));
    expect(pids.filter(alive)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await tree(join(f.repo, ".git"))).toEqual(before);
    expect([...before.keys()].filter((name) => name.endsWith(".lock"))).toEqual([]);
    expect([...before.keys()].filter((name) => name.startsWith("worktrees"))).toEqual([]);
    expect(await f.service.listWorktrees(f.repo)).toHaveLength(1);
    expect(await f.service.branchHead({ repo: f.repo, branch: "ace/cancel-busy" })).toBeUndefined();
    await expect(access(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.service.mutationState(f.repo)).toMatchObject({ status: "available" });
    expect(await f.service.status(f.repo)).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
  } finally {
    await f.service.close();
    await rm(f.home, { recursive: true, force: true });
    await rm(scripts, { recursive: true, force: true });
  }
});
