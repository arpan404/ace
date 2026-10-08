import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { GitService, type WorktreeProgress } from "./index.ts";

const git = promisify(execFile);
async function fixture() {
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
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Fixture",
  ]);
  return { home, repo, path: join(home, "tree"), service: new GitService() };
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
