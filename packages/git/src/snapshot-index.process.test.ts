import { chmod, lstat, readdir, readFile, readlink, rm, stat, utimes } from "node:fs/promises";
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
async function roundTrip(repo: string, threadId: string) {
  const expected = await disk(repo);
  const index = await readFile(join(repo, ".git", "index"));
  const checkpoint = await service.createCheckpoint({ worktree: repo, threadId, label: "before" });
  // A snapshot only reads the checkout's index.
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  for (const path of Object.keys(expected)) await rm(join(repo, path), { force: true });
  await put(repo, "scrambled.txt", "agent output\n");
  await service.restoreCheckpoint({ worktree: repo, checkpoint: checkpoint.id });
  expect(await disk(repo)).toEqual(expected);
  return checkpoint;
}

describe("snapshots seeded from the checkout's own index", () => {
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

  test("a path HEAD has as a file and the index as a directory keeps the index's shape", async () => {
    const repo = await repository({ "shape": "a file in HEAD\n" });
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
