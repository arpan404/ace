import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitCli } from "./cli.ts";
import { GitService } from "./index.ts";
import { git, put, repository, scratch } from "./test-repo.ts";

const service = new GitService();

test("fileLog lists a file's newest commits following renames, in one walk", async () => {
  const repo = await repository({ "old.ts": "export const a = 1;\n" });
  const firstSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });
  await put(repo, "old.ts", "export const a = 2;\n");
  await git(repo, "add", "old.ts");
  await git(repo, "commit", "-m", "Update old file");
  const secondSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });
  await rename(join(repo, "old.ts"), join(repo, "renamed.ts"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "Rename old.ts to renamed.ts");
  const thirdSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  const all = await service.fileLog({ worktree: repo, path: "renamed.ts" });
  expect(all.head).toBe(thirdSha);
  expect(all.stopped).toBeUndefined();
  expect(all.entries.map((entry) => entry.sha)).toEqual([thirdSha, secondSha, firstSha]);
  expect(all.entries[0]).toMatchObject({
    subject: "Rename old.ts to renamed.ts",
    path: "renamed.ts",
    previousPath: "old.ts",
  });
  expect(all.entries[1]?.path).toBe("old.ts");

  // More commits than the limit: the newest ones, and the list says it stopped at the limit.
  const limited = await service.fileLog({ worktree: repo, path: "renamed.ts", limit: 2 });
  expect(limited.entries.map((entry) => entry.sha)).toEqual([thirdSha, secondSha]);
  expect(limited.stopped).toBe("limit");
});

test("a walk stopped by its work budget says so, apart from one stopped at the limit", async () => {
  const repo = await repository({ "a.ts": "1\n" });
  const read = await service.fileLog({ worktree: repo, path: "a.ts", budgetMs: 0 });
  expect(read.stopped).toBe("budget");
});

test("fileLog returns an empty history on an unborn repository or untracked file", async () => {
  const emptyRepo = await scratch();
  await git(emptyRepo, "init");
  await put(emptyRepo, "draft.ts", "export const x = 1;\n");

  const unborn = await service.fileLog({ worktree: emptyRepo, path: "draft.ts" });
  expect(unborn).toEqual({ entries: [], head: null });

  const trackedRepo = await repository({ "tracked.ts": "one\n" });
  await put(trackedRepo, "untracked.ts", "two\n");
  const untracked = await service.fileLog({ worktree: trackedRepo, path: "untracked.ts" });
  expect(untracked.entries).toEqual([]);
  expect(untracked.stopped).toBeUndefined();
  expect(untracked.head).toMatch(/^[0-9a-f]{40,64}$/);
});

test("fileBlame blames a range at the commit it is given, and stops at its caps", async () => {
  const repo = await repository({ "app.ts": "line 1\nline 2\nline 3\nline 4\n" });
  const firstSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "app.ts", "line 1\nline 2 edited\nline 3\nline 4\n");
  await git(repo, "add", "app.ts");
  await git(repo, "commit", "-m", "Edit line 2");
  const secondSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  // The working tree and later commits do not change a blame read at an explicit commit.
  await put(repo, "app.ts", "inserted\nline 1\nline 2 edited\nline 3 dirty\nline 4\n");
  await put(repo, "other.ts", "x\n");
  await git(repo, "add", "other.ts");
  await git(repo, "commit", "-m", "Unrelated");

  const blamed = await service.fileBlame({
    worktree: repo,
    path: "app.ts",
    commit: secondSha,
    startLine: 2,
    endLine: 4,
  });
  expect(blamed.head).toBe(secondSha);
  expect(blamed.capped).toBe(false);
  expect(blamed.lines).toEqual([
    { line: 2, sha: secondSha },
    { line: 3, sha: firstSha },
    { line: 4, sha: firstSha },
  ]);
  expect(blamed.commits.find((c) => c.sha === secondSha)).toMatchObject({
    sha: secondSha,
    shortSha: secondSha.slice(0, 7),
    subject: "Edit line 2",
  });

  // A file the commit does not have returns no lines without throwing
  await put(repo, "brand-new.ts", "hello\n");
  const untracked = await service.fileBlame({
    worktree: repo,
    path: "brand-new.ts",
    commit: secondSha,
    startLine: 1,
    endLine: 10,
  });
  expect(untracked).toEqual({ head: secondSha, commits: [], lines: [], capped: false });

  // Byte cap stops cleanly and sets capped: true
  const capped = await service.fileBlame({
    worktree: repo,
    path: "app.ts",
    commit: secondSha,
    startLine: 1,
    endLine: 4,
    maxBytes: 120,
  });
  expect(capped.capped).toBe(true);
  expect(capped.lines.length).toBeLessThan(4);
});

test("fileBlame fails, rather than answering 'no such file', when Git cannot read the objects", async () => {
  const repo = await repository({ "app.ts": "one\ntwo\n" });
  const head = await service.resolveCommit({ worktree: repo, ref: "HEAD" });
  const blob = (await git(repo, "rev-parse", "HEAD:app.ts")).toString().trim();
  const objects = (await git(repo, "rev-parse", "--git-path", "objects")).toString().trim();
  await rm(join(repo, objects, blob.slice(0, 2), blob.slice(2)));
  await expect(
    service.fileBlame({ worktree: repo, path: "app.ts", commit: head, startLine: 1, endLine: 2 }),
  ).rejects.toBeInstanceOf(Error);

  // A commit the repository does not have is an error too, not an empty file.
  await expect(
    service.fileBlame({
      worktree: repo,
      path: "app.ts",
      commit: "e".repeat(40),
      startLine: 1,
      endLine: 2,
    }),
  ).rejects.toBeInstanceOf(Error);
});

test("fileBlame refuses a file too large to blame", async () => {
  const repo = await repository({ "big.txt": "line\n".repeat(10) });
  const head = await service.resolveCommit({ worktree: repo, ref: "HEAD" });
  await expect(
    service.fileBlame({
      worktree: repo,
      path: "big.txt",
      commit: head,
      startLine: 1,
      endLine: 5,
      maxFileBytes: 20,
    }),
  ).rejects.toMatchObject({ code: "file_too_large" });
});

/** The PID a git alias wrote, once it has. */
async function writtenPid(file: string): Promise<number> {
  for (let tries = 0; tries < 200; tries++) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (/^\d+\s*$/.test(text)) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the alias never wrote its PID");
}

/** Whether `pid` is gone within a few seconds of the call returning. */
async function exits(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 300; tries++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** An alias whose process writes its PID to a fresh file, then runs `body` (`&` backgrounds it). */
async function aliasWritingPid(body: string, background: boolean) {
  const file = join(await mkdtemp(join(tmpdir(), "ace-pid-")), "pid");
  const inner = `sh -c 'echo $$ > ${file}; exec ${body}'`;
  // Backgrounded, the alias's own shell (Git's child) exits at once while the helper keeps
  // Git's stdout open: the case where only the process group still names it.
  const alias = background ? `!f() { ${inner} & }; f` : `!f() { ${inner}; }; f`;
  return { file, args: ["-c", `alias.held=${alias}`, "held"] };
}

test.skipIf(process.platform === "win32")(
  "a read stopped at its byte cap leaves no descendant running, even after Git itself exited",
  async () => {
    const repo = await repository({ "a.ts": "1\n" });
    for (const background of [false, true]) {
      const { file, args } = await aliasWritingPid("yes", background);
      const started = Date.now();
      const out = await new GitCli({}).call(repo, args, {
        captureBytes: 4096,
        stopAtCapture: true,
      });
      expect(out.truncated).toBe(true);
      expect(out.stdout.length).toBe(4096);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await exits(await writtenPid(file))).toBe(true);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a silent read stopped by its work budget leaves no descendant running",
  async () => {
    const repo = await repository({ "a.ts": "1\n" });
    for (const background of [false, true]) {
      const { file, args } = await aliasWritingPid("sleep 60", background);
      const out = await new GitCli({}).call(repo, args, {
        captureBytes: 4096,
        stopAtCapture: true,
        stopAfterMs: 300,
      });
      expect(out.truncated).toBe(true);
      expect(await exits(await writtenPid(file))).toBe(true);
    }
  },
);

test("output of exactly the byte cap stops Git there", async () => {
  const repo = await repository({ "a.ts": "1\n" });
  // Exactly two bytes, then silence: only stopping at the cap itself ends the call.
  const started = Date.now();
  const out = await new GitCli({}).call(repo, ["-c", "alias.two=!printf yy; sleep 60", "two"], {
    captureBytes: 2,
    stopAtCapture: true,
  });
  expect(out).toMatchObject({ truncated: true });
  expect(out.stdout.toString()).toBe("yy");
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("diffCommit diffs a root commit, a regular commit, and a rename commit", async () => {
  const repo = await repository({ "a.ts": "export const value = 1;\n" });
  const rootSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await put(repo, "a.ts", "export const value = 2;\n");
  await git(repo, "add", "a.ts");
  await git(repo, "commit", "-m", "Change value to 2");
  const editSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  await rename(join(repo, "a.ts"), join(repo, "b.ts"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "Rename a.ts to b.ts");
  const renameSha = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  const rootDiff = await service.diffCommit({
    worktree: repo,
    commit: rootSha,
    paths: ["a.ts"],
  });
  expect(rootDiff.truncated).toBe(false);
  expect(rootDiff.patch).toContain("+export const value = 1;");

  const editDiff = await service.diffCommit({
    worktree: repo,
    commit: editSha,
    paths: ["a.ts"],
  });
  expect(editDiff.patch).toContain("-export const value = 1;");
  expect(editDiff.patch).toContain("+export const value = 2;");

  const renameDiff = await service.diffCommit({
    worktree: repo,
    commit: renameSha,
    paths: ["b.ts", "a.ts"],
  });
  expect(renameDiff.patch).toContain("rename from a.ts");
  expect(renameDiff.patch).toContain("rename to b.ts");
});

test("fileLog, fileBlame, and diffCommit reject unsafe paths, invalid refs, and bad line ranges", async () => {
  const repo = await repository({ "safe.ts": "one\ntwo\n" });
  const head = await service.resolveCommit({ worktree: repo, ref: "HEAD" });

  for (const badPath of ["../escape.ts", "/etc/passwd", ".git/config", "a\\b.ts", "a\0b.ts"]) {
    await expect(service.fileLog({ worktree: repo, path: badPath })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      service.fileBlame({ worktree: repo, path: badPath, commit: head, startLine: 1, endLine: 1 }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      service.diffCommit({ worktree: repo, commit: head, paths: [badPath] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }

  await expect(
    service.fileBlame({ worktree: repo, path: "safe.ts", commit: head, startLine: 5, endLine: 2 }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await expect(
    service.fileBlame({
      worktree: repo,
      path: "safe.ts",
      commit: head,
      startLine: 1,
      endLine: 600,
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await expect(
    service.diffCommit({ worktree: repo, commit: "--exec=bad", paths: ["safe.ts"] }),
  ).rejects.toMatchObject({ code: "invalid_ref" });

  // Blame range past EOF returns empty cleanly instead of throwing
  const pastEof = await service.fileBlame({
    worktree: repo,
    path: "safe.ts",
    commit: head,
    startLine: 50,
    endLine: 60,
  });
  expect(pastEof).toEqual({ head, commits: [], lines: [], capped: false });

  // A range that runs past the end (an unsaved buffer can be longer) blames the lines that exist
  const overEnd = await service.fileBlame({
    worktree: repo,
    path: "safe.ts",
    commit: head,
    startLine: 1,
    endLine: 120,
  });
  expect(overEnd.lines).toEqual([
    { line: 1, sha: head },
    { line: 2, sha: head },
  ]);

  // Non-repository folder fails with typed not_a_repo error
  const plain = await scratch();
  await put(plain, "notes.txt", "hello\n");
  await expect(service.fileLog({ worktree: plain, path: "notes.txt" })).rejects.toMatchObject({
    code: "not_a_repo",
  });
});
