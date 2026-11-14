import {
  chmod,
  lstat,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scratch } from "./test-repo.ts";

const service = new GitService();
const posix = process.platform !== "win32";

/** Every file below `root` outside `.git`: its bytes, symlink target and executable bit. */
async function disk(root: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(join(root, prefix))) {
    if (!prefix && name === ".git") continue;
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isDirectory()) Object.assign(files, await disk(root, path));
    else if (info.isSymbolicLink()) files[path] = `link:${await readlink(join(root, path))}`;
    else
      files[path] =
        `${info.mode & 0o100 ? "x" : "-"}:${(await readFile(join(root, path))).toString("hex")}`;
  }
  return files;
}

/** Checkpoint, scramble the checkout, restore: the checkout must be exactly as it was. */
async function roundTrip(repo: string, threadId: string, checkpoints: GitService = service) {
  const expected = await disk(repo);
  const index = await readFile(join(repo, ".git", "index"));
  const checkpoint = await checkpoints.createCheckpoint({
    worktree: repo,
    threadId,
    label: "before",
  });
  // A snapshot only reads the checkout's index.
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  for (const path of Object.keys(expected)) await rm(join(repo, path), { force: true });
  await put(repo, "scrambled.txt", "agent output\n");
  await checkpoints.restoreCheckpoint({ worktree: repo, checkpoint: checkpoint.id });
  expect(await disk(repo)).toEqual(expected);
  return checkpoint;
}

/**
 * Stage `path` long enough ago that Git trusts its stat data, then rewrite it with bytes of the
 * same length and put its old timestamp back, as a timestamp-preserving tool can.
 */
async function hiddenEdit(repo: string, path: string, content: string) {
  const old = new Date(Date.now() - 120_000);
  await utimes(join(repo, path), old, old);
  await git(repo, "update-index", "--refresh");
  await put(repo, path, content);
  await utimes(join(repo, path), old, old);
}

describe("checkpoints hold the bytes on disk", () => {
  test("untracked files, deletions, mode changes and a dirty index restore byte for byte", async () => {
    const repo = await repository({
      "edited.txt": "original\n",
      "deleted.txt": "gone soon\n",
      "staged.txt": "committed\n",
      "script.sh": "echo hi\n",
      "nested/deep/file.txt": "deep\n",
    });
    await put(repo, "edited.txt", "edited in the working tree\n");
    await rm(join(repo, "deleted.txt"));
    if (posix) await chmod(join(repo, "script.sh"), 0o755);
    // The index holds one version, the working tree another: the working tree is what counts.
    await put(repo, "staged.txt", "staged version\n");
    await git(repo, "add", "staged.txt");
    await put(repo, "staged.txt", "working version\n");
    await put(repo, "untracked/new.txt", "brand new\n");
    const checkpoint = await roundTrip(repo, "mixed");
    expect((await git(repo, "show", `${checkpoint.sha}:staged.txt`)).toString()).toBe(
      "working version\n",
    );
  });

  test("an edit that keeps the size and timestamp the index recorded is still captured", async () => {
    const repo = await repository({ "same.txt": "aaaa\n" });
    await git(repo, "update-index", "--refresh");
    const recorded = await stat(join(repo, "same.txt"));
    await put(repo, "same.txt", "bbbb\n");
    await utimes(join(repo, "same.txt"), recorded.atime, recorded.mtime);
    const checkpoint = await service.createCheckpoint({
      worktree: repo,
      threadId: "stat",
      label: "same stat",
    });
    expect((await git(repo, "show", `${checkpoint.sha}:same.txt`)).toString()).toBe("bbbb\n");
  });

  test("an equal-length edit with its timestamp restored is captured when Git ignores ctime", async () => {
    const repo = await repository({ "same.txt": "aaaa\n" });
    await git(repo, "config", "core.trustctime", "false");
    await hiddenEdit(repo, "same.txt", "bbbb\n");
    const checkpoint = await roundTrip(repo, "trustctime");
    expect((await git(repo, "show", `${checkpoint.sha}:same.txt`)).toString()).toBe("bbbb\n");
  });

  test("an equal-length edit with its timestamp restored is captured with default settings", async () => {
    const repo = await repository({ "same.txt": "aaaa\n" });
    await hiddenEdit(repo, "same.txt", "bbbb\n");
    const checkpoint = await roundTrip(repo, "default-stat");
    expect((await git(repo, "show", `${checkpoint.sha}:same.txt`)).toString()).toBe("bbbb\n");
  });

  for (const [setting, value] of [
    ["core.ignoreStat", "true"],
    ["core.checkStat", "minimal"],
  ] as const)
    test(`an equal-length edit is captured with ${setting}=${value}`, async () => {
      const repo = await repository({ "same.txt": "aaaa\n" });
      await git(repo, "config", setting, value);
      await hiddenEdit(repo, "same.txt", "bbbb\n");
      const checkpoint = await roundTrip(repo, setting.replace(".", "-"));
      expect((await git(repo, "show", `${checkpoint.sha}:same.txt`)).toString()).toBe("bbbb\n");
    });

  test("a path marked both assume-unchanged and skip-worktree is captured as edited", async () => {
    const repo = await repository({ "both.txt": "original\n" });
    await git(repo, "update-index", "--assume-unchanged", "both.txt");
    await git(repo, "update-index", "--skip-worktree", "both.txt");
    expect((await git(repo, "ls-files", "-v", "both.txt")).toString()).toBe("s both.txt\n");
    await put(repo, "both.txt", "edited by the person\n");
    const checkpoint = await roundTrip(repo, "both-flags");
    expect((await git(repo, "show", `${checkpoint.sha}:both.txt`)).toString()).toBe(
      "edited by the person\n",
    );
  });

  test.runIf(posix)("an fsmonitor that reports nothing changed cannot hide an edit", async () => {
    const repo = await repository({ "watched.txt": "aaaa\n" });
    const monitor = join(await scratch(), "monitor.sh");
    // Version 2 protocol: a token, then no changed paths, every time.
    await writeFile(monitor, "#!/bin/sh\nprintf 'token\\0'\n");
    await chmod(monitor, 0o755);
    await git(repo, "config", "core.fsmonitor", monitor);
    await git(repo, "config", "core.fsmonitorHookVersion", "2");
    await git(repo, "config", "core.untrackedCache", "true");
    await git(repo, "update-index", "--untracked-cache", "--fsmonitor");
    await git(repo, "status", "--porcelain");
    await hiddenEdit(repo, "watched.txt", "bbbb\n");
    await put(repo, "new-dir/new.txt", "new file\n");
    // The person's own Git now believes the edit and the new file are not there.
    expect((await git(repo, "status", "--porcelain")).toString()).not.toContain("watched.txt");
    const checkpoint = await roundTrip(repo, "fsmonitor");
    expect((await git(repo, "show", `${checkpoint.sha}:watched.txt`)).toString()).toBe("bbbb\n");
    expect((await git(repo, "show", `${checkpoint.sha}:new-dir/new.txt`)).toString()).toBe(
      "new file\n",
    );
  });

  test.runIf(posix)(
    "a restore under an fsmonitor that reports nothing changed keeps every byte",
    async () => {
      const repo = await repository({ "watched.txt": "aaaa\n", "other.txt": "other\n" });
      const target = await service.createCheckpoint({
        worktree: repo,
        threadId: "lying",
        label: "a",
      });
      const monitor = join(await scratch(), "monitor.sh");
      await writeFile(monitor, "#!/bin/sh\nprintf 'token\\0'\n");
      await chmod(monitor, 0o755);
      await git(repo, "config", "core.fsmonitor", monitor);
      await git(repo, "config", "core.fsmonitorHookVersion", "2");
      await git(repo, "config", "core.untrackedCache", "true");
      await git(repo, "update-index", "--untracked-cache", "--fsmonitor");
      await git(repo, "status", "--porcelain");
      await hiddenEdit(repo, "watched.txt", "bbbb\n");
      await put(repo, "new-dir/new.txt", "new file\n");
      const edited = await disk(repo);
      // Restoring the earlier checkpoint writes its bytes although the monitor claims no change.
      const { safetyCheckpointId } = await service.restoreCheckpoint({
        worktree: repo,
        checkpoint: target.id,
      });
      expect(await readFile(join(repo, "watched.txt"), "utf8")).toBe("aaaa\n");
      await expect(stat(join(repo, "new-dir/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      // The safety checkpoint taken during the restore saw the hidden edit and the new file.
      await service.restoreCheckpoint({ worktree: repo, checkpoint: safetyCheckpointId });
      expect(await disk(repo)).toEqual(edited);
    },
  );

  test.runIf(posix)(
    "a file staged through a clean filter restores its own bytes when filters are off",
    async () => {
      const repo = await repository({ ".gitattributes": "*.bin filter=pointer\n" });
      await git(repo, "config", "filter.pointer.clean", "printf pointer");
      await git(repo, "config", "filter.pointer.smudge", "cat");
      await put(repo, "large.bin", "the real large content\n");
      // Old enough that Git trusts the stat data it records for the filtered file.
      const old = new Date(Date.now() - 120_000);
      await utimes(join(repo, "large.bin"), old, old);
      await git(repo, "add", "large.bin");
      await git(repo, "commit", "-qm", "Large file");
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      // ace's own snapshots run without the person's filters.
      const guarded = new GitService();
      await guarded.nonExecuting(() => roundTrip(repo, "filter", guarded));
      await guarded.close();
    },
  );

  test("an index in version 4 format, and one held by another Git's index.lock, is read", async () => {
    const repo = await repository({ "a.txt": "a\n", "b/c.txt": "c\n" });
    await git(repo, "update-index", "--index-version", "4");
    await put(repo, "a.txt", "edited\n");
    await writeFile(join(repo, ".git", "index.lock"), "");
    await roundTrip(repo, "v4");
    expect(await readFile(join(repo, ".git", "index.lock"), "utf8")).toBe("");
    await rm(join(repo, ".git", "index.lock"));
  });

  test("an intent-to-add file is captured with its working contents", async () => {
    const repo = await repository({ "a.txt": "a\n" });
    await put(repo, "intent.txt", "planned\n");
    await git(repo, "add", "-N", "intent.txt");
    const checkpoint = await roundTrip(repo, "intent");
    expect((await git(repo, "show", `${checkpoint.sha}:intent.txt`)).toString()).toBe("planned\n");
  });

  test("a path HEAD has as a file and the index as a directory keeps the index's shape", async () => {
    const repo = await repository({ shape: "a file in HEAD\n" });
    await git(repo, "rm", "--cached", "-q", "shape");
    await rm(join(repo, "shape"));
    await put(repo, "shape/inner.txt", "now a directory\n");
    await git(repo, "add", "shape/inner.txt");
    const checkpoint = await roundTrip(repo, "shape");
    expect((await git(repo, "show", `${checkpoint.sha}:shape/inner.txt`)).toString()).toBe(
      "now a directory\n",
    );
  });

  test("a checkout in the middle of a merge conflict is captured as it is on disk", async () => {
    const repo = await repository({ "conflict.txt": "base\n" });
    await git(repo, "checkout", "-q", "-b", "other");
    await put(repo, "conflict.txt", "theirs\n");
    await git(repo, "commit", "-qam", "Theirs");
    await git(repo, "checkout", "-q", "main");
    await put(repo, "conflict.txt", "ours\n");
    await git(repo, "commit", "-qam", "Ours");
    await git(repo, "merge", "-q", "other").catch(() => undefined);
    const checkpoint = await roundTrip(repo, "conflict");
    expect((await git(repo, "show", `${checkpoint.sha}:conflict.txt`)).toString()).toContain(
      "<<<<<<<",
    );
    expect((await git(repo, "ls-files", "--unmerged")).toString()).toContain("conflict.txt");
  });

  test("a split index is read without adding shared index files", async () => {
    const repo = await repository({ "tracked.txt": "tracked\n" });
    await git(repo, "update-index", "--split-index");
    await put(repo, "tracked.txt", "changed\n");
    const shared = (await readdir(join(repo, ".git"))).filter((name) =>
      name.startsWith("sharedindex."),
    );
    await roundTrip(repo, "split");
    expect(
      (await readdir(join(repo, ".git"))).filter((name) => name.startsWith("sharedindex.")),
    ).toEqual(shared);
  });

  test("a linked worktree is captured from its own index", async () => {
    const repo = await repository({ "tracked.txt": "main\n" });
    const tree = join(await scratch(), "linked");
    await git(repo, "worktree", "add", "-q", "-b", "linked", tree);
    await put(tree, "tracked.txt", "linked edit\n");
    await put(tree, "only-here.txt", "untracked\n");
    const checkpoint = await service.createCheckpoint({
      worktree: tree,
      threadId: "linked",
      label: "linked",
    });
    expect((await git(tree, "show", `${checkpoint.sha}:tracked.txt`)).toString()).toBe(
      "linked edit\n",
    );
    expect((await git(tree, "show", `${checkpoint.sha}:only-here.txt`)).toString()).toBe(
      "untracked\n",
    );
  });

  for (const mode of ["--cone", "--no-cone"])
    test(`sparse checkout (${mode}) refuses checkpoints and restores without touching files`, async () => {
      const repo = await repository({ "included/a.txt": "a\n", "other/b.txt": "b\n" });
      const before = await service.createCheckpoint({
        worktree: repo,
        threadId: "sparse-mode",
        label: "full",
      });
      await git(
        repo,
        "sparse-checkout",
        "set",
        mode,
        mode === "--cone" ? "included" : "/included/",
      );
      const files = await disk(repo);
      expect(Object.keys(files)).not.toContain("other/b.txt");
      const index = await readFile(join(repo, ".git", "index"));
      await expect(
        service.createCheckpoint({ worktree: repo, threadId: "sparse-mode", label: "sparse" }),
      ).rejects.toMatchObject({ code: "unsupported_repository" });
      await expect(
        service.restoreCheckpoint({ worktree: repo, checkpoint: before.id }),
      ).rejects.toMatchObject({ code: "unsupported_repository" });
      expect(await disk(repo)).toEqual(files);
      expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
      expect(await service.listCheckpoints({ repo, threadId: "sparse-mode" })).toHaveLength(1);
    });

  test("turning sparse checkout off lets the next snapshot run", async () => {
    const repo = await repository({ "included/a.txt": "a\n", "other/b.txt": "b\n" });
    await git(repo, "sparse-checkout", "init", "--cone");
    await expect(
      service.createCheckpoint({ worktree: repo, threadId: "sparse", label: "on" }),
    ).rejects.toMatchObject({ code: "unsupported_repository" });
    await git(repo, "sparse-checkout", "disable");
    await expect(
      service.createCheckpoint({ worktree: repo, threadId: "sparse", label: "off" }),
    ).resolves.toMatchObject({ sequence: 1 });
  });
});
