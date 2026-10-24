import { chmod, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

let service: GitService;
beforeEach(() => {
  service = new GitService();
});
afterEach(() => service.close());

const binary = Buffer.from([0, 1, 2, 255, 0, 10, 13, 0, 128]);
const sortedStatus = async (repo: string) =>
  (await scalar(repo, "status", "--porcelain", "--untracked-files=all")).split("\n").sort();

/** A checkout with one of every kind of uncommitted change. */
async function changedSource() {
  const repo = await repository({
    "tracked.txt": "original\n",
    "gone.txt": "bye\n",
    "old-name.txt": "moved content\n".repeat(20),
    "script.sh": "echo hi\n",
    ".gitignore": "*.secret\n",
  });
  await git(repo, "tag", "v1");
  await put(repo, "tracked.txt", "edited\n");
  await rm(join(repo, "gone.txt"));
  await rm(join(repo, "old-name.txt"));
  await put(repo, "new-name.txt", "moved content\n".repeat(20));
  await chmod(join(repo, "script.sh"), 0o755);
  await put(repo, "image.bin", binary);
  await put(repo, "notes/untracked.txt", "untracked\n");
  await put(repo, "token.secret", "never sent\n");
  return repo;
}

test("a checkout's branches, tags and uncommitted changes arrive whole through a bundle", async () => {
  const source = await changedSource();
  const captured = await service.transfer.captureChanges(source, { ref: "refs/ace/transfer/t1" });
  const refs = await service.transfer.bundleRefs(source);
  expect(refs).toMatchObject({
    branch: "main",
    branches: ["refs/heads/main"],
    tags: ["refs/tags/v1"],
  });
  const file = join(await scratch(), "full.bundle");
  const written = await service.transfer.createBundle(source, {
    file,
    refs: [...refs.branches, ...refs.tags, "refs/ace/transfer/t1"],
  });
  expect(written).toEqual({ bytes: (await stat(file)).size });

  const parent = await scratch();
  const target = join(parent, "landed");
  expect(await service.transfer.cloneFromBundle({ parent, path: target, bundle: file })).toEqual({
    branch: "main",
  });
  expect(await scalar(target, "remote")).toBe("");
  expect(await scalar(target, "rev-parse", "HEAD")).toBe(refs.head);
  expect(await scalar(target, "rev-parse", "v1")).toBe(refs.head);
  expect(await scalar(target, "status", "--porcelain")).toBe("");

  await service.transfer.applyChanges(target, captured?.commit ?? "");
  await service.transfer.deleteRef(target, "refs/ace/transfer/t1");

  expect(await sortedStatus(target)).toEqual(await sortedStatus(source));
  expect(await scalar(target, "rev-parse", "HEAD")).toBe(refs.head);
  expect(await scalar(target, "branch", "--show-current")).toBe("main");
  expect(await readFile(join(target, "image.bin"))).toEqual(binary);
  expect(await readFile(join(target, "new-name.txt"), "utf8")).toBe("moved content\n".repeat(20));
  expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("edited\n");
  expect((await stat(join(target, "script.sh"))).mode & 0o111).not.toBe(0);
  await expect(stat(join(target, "old-name.txt"))).rejects.toThrow();
  await expect(stat(join(target, "gone.txt"))).rejects.toThrow();
  await expect(stat(join(target, "token.secret"))).rejects.toThrow();
  expect(await scalar(target, "diff", "--cached", "--name-only")).toBe("");
});

test("changes are refused, and nothing written, when the target edited the same files", async () => {
  const source = await changedSource();
  const captured = await service.transfer.captureChanges(source, { ref: "refs/ace/transfer/t1" });
  const file = join(await scratch(), "full.bundle");
  await service.transfer.createBundle(source, {
    file,
    refs: ["refs/heads/main", "refs/ace/transfer/t1"],
  });
  const parent = await scratch();
  const target = join(parent, "landed");
  await service.transfer.cloneFromBundle({ parent, path: target, bundle: file, branch: "main" });
  await put(target, "tracked.txt", "the target's own edit\n");

  await expect(service.transfer.applyChanges(target, captured?.commit ?? "")).rejects.toMatchObject(
    {
      code: "dirty_worktree",
    },
  );
  expect(await sortedStatus(target)).toEqual([" M tracked.txt"]);
  expect(await readFile(join(target, "tracked.txt"), "utf8")).toBe("the target's own edit\n");
});

/** A source pushed to a bare origin, and a target that cloned origin. */
async function originPair() {
  const source = await repository();
  const directory = await scratch();
  const origin = join(directory, "origin.git");
  await git(directory, "init", "-q", "--bare", origin);
  await git(source, "remote", "add", "origin", origin);
  await git(source, "push", "-q", "origin", "main");
  await git(directory, "clone", "-q", origin, "target");
  return { source, origin, target: join(directory, "target") };
}

test("an incremental bundle holds only what origin lacks, and is empty when nothing is new", async () => {
  const { source, target } = await originPair();
  const before = await service.transfer.bundleRefs(source);
  expect(before.originTracking).toEqual(["refs/remotes/origin/main"]);
  const nothing = join(await scratch(), "nothing.bundle");
  expect(
    await service.transfer.createBundle(source, {
      file: nothing,
      refs: before.branches,
      exclude: before.originTracking,
    }),
  ).toEqual({ empty: true });
  await expect(stat(nothing)).rejects.toThrow();

  await put(source, "next.txt", "next\n");
  await git(source, "add", "next.txt");
  await git(source, "commit", "-q", "-m", "Next");
  await put(source, "tracked.txt", "uncommitted\n");
  const captured = await service.transfer.captureChanges(source, { ref: "refs/ace/transfer/t2" });
  const file = join(await scratch(), "delta.bundle");
  const refs = await service.transfer.bundleRefs(source);
  await service.transfer.createBundle(source, {
    file,
    refs: [...refs.branches, "refs/ace/transfer/t2"],
    exclude: refs.originTracking,
  });

  const empty = join(await scratch(), "empty");
  await git(await scratch(), "init", "-q", empty);
  expect(await service.transfer.verifyBundle(empty, file)).toBe(false);
  await expect(
    service.transfer.fetchBundle(empty, file, ["refs/heads/main:refs/ace/incoming/main"]),
  ).rejects.toMatchObject({ code: "objects_not_available" });

  expect(await service.transfer.verifyBundle(target, file)).toBe(true);
  await service.transfer.fetchBundle(target, file, [
    "refs/heads/main:refs/ace/incoming/main",
    "refs/ace/transfer/t2:refs/ace/transfer/t2",
  ]);
  expect(await scalar(target, "rev-parse", "refs/ace/incoming/main")).toBe(refs.head);
  expect(await scalar(target, "rev-parse", "refs/ace/transfer/t2")).toBe(captured?.commit);
  expect(await scalar(target, "rev-parse", "refs/heads/main")).toBe(before.head);
  expect(await scalar(target, "status", "--porcelain")).toBe("");
});

test("only a bundle file opens Git's file transport, never another repository", async () => {
  const { source, origin, target } = await originPair();
  await put(source, "next.txt", "next\n");
  await git(source, "add", "next.txt");
  await git(source, "commit", "-q", "-m", "Next");
  await git(source, "push", "-q", "origin", "main");
  for (const path of [origin, join(source, ".git"), `file://${origin}`, "relative.bundle"])
    await expect(
      service.transfer.fetchBundle(target, path, ["refs/heads/main:refs/ace/incoming/main"]),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  await expect(service.transfer.verifyBundle(target, origin)).rejects.toMatchObject({
    code: "invalid_argument",
  });
  expect(await scalar(target, "for-each-ref", "refs/ace")).toBe("");
});
