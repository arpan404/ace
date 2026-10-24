import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

let service: GitService;
beforeEach(() => {
  service = new GitService();
});
afterEach(() => service.close());

async function commit(repo: string, file: string, content: string): Promise<string> {
  await put(repo, file, content);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", file);
  return scalar(repo, "rev-parse", "HEAD");
}

test("a branch the target already uses for other commits lands beside it with the machine's name", async () => {
  const repo = await repository();
  const base = await scalar(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-q", "-c", "feature");
  const theirs = await commit(repo, "theirs.txt", "target's own work\n");
  await git(repo, "switch", "-q", "main");
  const incoming = await commit(repo, "incoming.txt", "sent work\n");
  const machine = "Arpan’s MacBook Pro";

  expect(
    await service.transfer.landingBranch(repo, { branch: "feature", commit: incoming, machine }),
  ).toEqual({ branch: "feature-from-arpans-macbook-pro", existing: false });
  await service.transfer.createBranch(repo, "feature-from-arpans-macbook-pro", incoming);
  expect(
    await service.transfer.landingBranch(repo, { branch: "feature", commit: incoming, machine }),
  ).toEqual({ branch: "feature-from-arpans-macbook-pro", existing: true });
  expect(await scalar(repo, "rev-parse", "feature")).toBe(theirs);

  // An ancestor is still the target's own branch: it is never moved.
  await git(repo, "branch", "behind", base);
  expect(
    await service.transfer.landingBranch(repo, { branch: "behind", commit: incoming, machine }),
  ).toEqual({ branch: "behind-from-arpans-macbook-pro", existing: false });
  expect(
    await service.transfer.landingBranch(repo, { branch: "fresh", commit: incoming, machine }),
  ).toEqual({ branch: "fresh", existing: false });
  await expect(service.transfer.createBranch(repo, "feature", incoming)).rejects.toMatchObject({
    code: "branch_exists",
  });
  expect(await scalar(repo, "rev-parse", "feature")).toBe(theirs);
});

test("checkout state counts tracked edits and untracked files, not ignored ones", async () => {
  const repo = await repository();
  const head = await scalar(repo, "rev-parse", "HEAD");
  await put(repo, "ignored/build.log", "noise\n");
  expect(await service.transfer.checkoutState(repo)).toEqual({ clean: true, branch: "main", head });
  await put(repo, "draft.txt", "draft\n");
  expect(await service.transfer.checkoutState(repo)).toMatchObject({ clean: false });
  await git(repo, "switch", "-q", "--detach");
  expect(await service.transfer.checkoutState(repo)).toEqual({ clean: false, head });
});

test("a clean checkout switches to a branch reset to the transferred commit; a dirty one refuses", async () => {
  const repo = await repository();
  const base = await scalar(repo, "rev-parse", "HEAD");
  const next = await commit(repo, "next.txt", "next\n");
  await git(repo, "switch", "-q", "-c", "topic", base);
  await service.transfer.checkoutBranch(repo, { name: "topic", commit: next });
  expect(await scalar(repo, "branch", "--show-current")).toBe("topic");
  expect(await scalar(repo, "rev-parse", "HEAD")).toBe(next);
  expect(await scalar(repo, "status", "--porcelain")).toBe("");

  await put(repo, "tracked.txt", "uncommitted\n");
  await expect(
    service.transfer.checkoutBranch(repo, { name: "other", commit: base }),
  ).rejects.toMatchObject({ code: "dirty_worktree" });
  expect(await scalar(repo, "branch", "--show-current")).toBe("topic");
});

test("fast-forward moves the checked-out branch, and refuses when the branch has its own commits", async () => {
  const repo = await repository();
  const base = await scalar(repo, "rev-parse", "HEAD");
  const ahead = await commit(repo, "ahead.txt", "ahead\n");
  await git(repo, "switch", "-q", "-c", "follow", base);
  await service.transfer.fastForward(repo, ahead);
  expect(await scalar(repo, "rev-parse", "follow")).toBe(ahead);
  expect(await scalar(repo, "status", "--porcelain")).toBe("");

  const own = await commit(repo, "own.txt", "own\n");
  await git(repo, "switch", "-q", "-c", "diverged", base);
  const mine = await commit(repo, "mine.txt", "mine\n");
  await expect(service.transfer.fastForward(repo, own)).rejects.toMatchObject({
    code: "head_moved",
    details: { reason: "not_fast_forward" },
  });
  expect(await scalar(repo, "rev-parse", "HEAD")).toBe(mine);
});

test("a branch worktree opens an existing branch in a new folder only", async () => {
  const repo = await repository();
  const next = await commit(repo, "next.txt", "next\n");
  await git(repo, "branch", "landed", next);
  await git(repo, "reset", "-q", "--hard", "HEAD~1");
  const directory = await scratch();
  const path = join(directory, "landed");
  await service.transfer.addBranchWorktree(repo, { path, branch: "landed" });
  expect(await scalar(path, "branch", "--show-current")).toBe("landed");
  expect(await scalar(path, "rev-parse", "HEAD")).toBe(next);
  expect((await stat(join(path, "next.txt"))).isFile()).toBe(true);
  expect(await scalar(repo, "branch", "--show-current")).toBe("main");

  await expect(
    service.transfer.addBranchWorktree(repo, { path: directory, branch: "landed" }),
  ).rejects.toMatchObject({ code: "path_exists" });
  await expect(
    service.transfer.addBranchWorktree(repo, { path: join(directory, "x"), branch: "missing" }),
  ).rejects.toMatchObject({ code: "invalid_ref" });
});
