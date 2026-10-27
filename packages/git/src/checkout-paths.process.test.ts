import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scratch } from "./test-repo.ts";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe.runIf(process.platform === "win32")("Windows checkouts", () => {
  test("a git.exe committed inside the checkout never runs in place of the person's Git", async () => {
    const repo = await repository();
    // A stand-in that can't answer as Git: Node rejects Git's --no-pager option.
    await copyFile(process.execPath, join(repo, "git.exe"));
    const service = new GitService();
    try {
      const info = await service.projectInfo(repo);
      expect(info.branch).toBe("main");
    } finally {
      await service.close();
    }
  });

  test("with no Git on PATH, a git.exe in the checkout never runs and Git is reported missing", async () => {
    const repo = await repository();
    await copyFile(process.execPath, join(repo, "git.exe"));
    const path = process.env.PATH;
    // Only Windows' own commands: no Git anywhere on PATH.
    process.env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const service = new GitService();
    try {
      await expect(service.projectInfo(repo)).rejects.toMatchObject({ code: "git_missing" });
    } finally {
      process.env.PATH = path;
      await service.close();
    }
  });

  test("a worktree checks out paths past MAX_PATH without changing the person's repository config", async () => {
    const repo = await repository();
    const deep = Array.from({ length: 12 }, (_, index) => `folder-${index}-${"x".repeat(18)}`);
    await mkdir(join(repo, ...deep), { recursive: true });
    await writeFile(join(repo, ...deep, "deep.txt"), "deep\n");
    expect(join(repo, ...deep, "deep.txt").length).toBeGreaterThan(260);
    await git(repo, "-c", "core.longpaths=true", "add", "--all");
    await git(repo, "-c", "core.longpaths=true", "commit", "-m", "Deep");
    const config = await readFile(join(repo, ".git", "config"));
    const worktree = join(await scratch(), "long");
    const service = new GitService();
    try {
      await service.createWorktree({ repo, path: worktree, baseRef: "HEAD", branch: "long" });
      expect(await readFile(join(worktree, ...deep, "deep.txt"), "utf8")).toContain("deep");
      expect(await service.status(worktree)).toEqual({
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
      });
    } finally {
      await service.close();
    }
    // The shared config is the person's main checkout's too: ace leaves it as it was.
    expect(await readFile(join(repo, ".git", "config"))).toEqual(config);
  });

  test("worktrees, checkpoints and restore under core.autocrlf=true leave no line-ending changes", async () => {
    const repo = await repository({ "lines.txt": "one\ntwo\n", "keep.txt": "keep\n" });
    await git(repo, "config", "core.autocrlf", "true");
    const worktree = join(await scratch(), "crlf");
    const service = new GitService();
    try {
      await service.createWorktree({ repo, path: worktree, baseRef: "HEAD", branch: "crlf" });
      expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("keep\r\n");
      expect(
        (
          await service.diff({
            worktree,
            from: { kind: "commit", ref: "HEAD" },
            to: { kind: "working-tree" },
          })
        ).entries,
      ).toEqual([]);
      await writeFile(join(worktree, "lines.txt"), "one\r\nchanged\r\n");
      const checkpoint = await service.createCheckpoint({
        worktree,
        threadId: "crlf",
        label: "turn",
      });
      await writeFile(join(worktree, "lines.txt"), "later\r\n");
      await service.restoreCheckpoint({ worktree, checkpoint: checkpoint.id });
      expect(await readFile(join(worktree, "lines.txt"), "utf8")).toBe("one\r\nchanged\r\n");
      expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("keep\r\n");
      const changed = await service.diff({
        worktree,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      });
      expect(changed.entries.map((entry) => entry.path)).toEqual(["lines.txt"]);
      expect(
        (
          await service.diff({
            worktree,
            from: { kind: "checkpoint", id: checkpoint.id },
            to: { kind: "working-tree" },
          })
        ).entries,
      ).toEqual([]);
    } finally {
      await service.close();
    }
    expect(await exists(join(worktree, ".git"))).toBe(true);
  });
});
