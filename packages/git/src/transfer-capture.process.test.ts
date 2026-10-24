import { createHash } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

let service: GitService;
beforeEach(() => {
  service = new GitService();
});
afterEach(() => service.close());

const indexHash = async (repo: string) =>
  createHash("sha256")
    .update(await readFile(join(repo, ".git", "index")))
    .digest("hex");

test("capturing changes leaves the checkout and its index byte-identical", async () => {
  const repo = await repository({
    "tracked.txt": "original\n",
    "gone.txt": "bye\n",
    ".gitignore": "*.secret\n",
  });
  await put(repo, "tracked.txt", "edited\n");
  await put(repo, "staged.txt", "staged\n");
  await git(repo, "add", "staged.txt");
  await rm(join(repo, "gone.txt"));
  await put(repo, "new/untracked.txt", "new\n");
  await put(repo, "token.secret", "hidden\n");
  const status = await scalar(repo, "status", "--porcelain");
  const index = await indexHash(repo);
  const head = await scalar(repo, "rev-parse", "HEAD");

  const captured = await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/t1" });

  expect(await indexHash(repo)).toBe(index);
  expect(await scalar(repo, "status", "--porcelain")).toBe(status);
  expect(await scalar(repo, "rev-parse", "HEAD")).toBe(head);
  expect(captured?.head).toBe(head);
  expect(await scalar(repo, "rev-parse", "refs/ace/transfer/t1")).toBe(captured?.commit);
  expect(await scalar(repo, "rev-parse", `${captured?.commit}^`)).toBe(head);
  expect(
    (await scalar(repo, "ls-tree", "-r", "--name-only", "refs/ace/transfer/t1")).split("\n").sort(),
  ).toEqual([".gitignore", "new/untracked.txt", "staged.txt", "tracked.txt"]);
  expect(await scalar(repo, "show", "refs/ace/transfer/t1:tracked.txt")).toBe("edited");
});

test("a clean checkout has nothing to capture and creates no ref", async () => {
  const repo = await repository();
  await put(repo, "ignored/cache.bin", "ignored\n");
  expect(
    await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/none" }),
  ).toBeUndefined();
  expect(await scalar(repo, "for-each-ref", "refs/ace")).toBe("");
});

test("the capture commit uses ace's identity even without a configured user", async () => {
  const repo = await repository();
  await git(repo, "config", "user.name", "");
  await git(repo, "config", "user.useConfigOnly", "true");
  await put(repo, "tracked.txt", "edited\n");
  const captured = await service.transfer.captureChanges(repo, {
    ref: "refs/ace/transfer/id",
    message: "Changes from MacBook",
  });
  expect(await scalar(repo, "log", "-1", "--format=%an <%ae>%n%s", captured?.commit ?? "")).toBe(
    "ace <transfers@ace.local>\nChanges from MacBook",
  );
});

test("changes in a repository with no commits are captured as a root commit", async () => {
  const directory = await scratch();
  await git(directory, "init", "-q", "-b", "main", "fresh");
  const repo = join(directory, "fresh");
  await put(repo, "first.txt", "first\n");
  const captured = await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/root" });
  expect(captured?.head).toBeUndefined();
  expect(await scalar(repo, "rev-list", "--count", "refs/ace/transfer/root")).toBe("1");
  expect(await scalar(repo, "show", "refs/ace/transfer/root:first.txt")).toBe("first");
});

test("a repository nested in the checkout is not captured as part of it", async () => {
  const repo = await repository();
  const nested = join(repo, "vendor", "lib");
  await git(repo, "init", "-q", nested);
  await put(nested, "inner.txt", "inner\n");
  await put(repo, "outer.txt", "outer\n");
  await chmod(join(repo, "tracked.txt"), 0o755);
  const captured = await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/n" });
  const tree = await scalar(repo, "ls-tree", "-r", captured?.commit ?? "");
  expect(tree).toContain("outer.txt");
  expect(tree).toMatch(/^100755 blob [0-9a-f]+\ttracked\.txt$/m);
  expect(tree).not.toContain("vendor");
});

test("deleting a transfer ref removes only that ref", async () => {
  const repo = await repository();
  await put(repo, "tracked.txt", "edited\n");
  await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/a" });
  await service.transfer.captureChanges(repo, { ref: "refs/ace/transfer/b" });
  await service.transfer.deleteRef(repo, "refs/ace/transfer/a");
  expect(await scalar(repo, "for-each-ref", "--format=%(refname)", "refs/ace")).toBe(
    "refs/ace/transfer/b",
  );
  await expect(service.transfer.deleteRef(repo, "HEAD")).rejects.toMatchObject({
    code: "invalid_ref",
  });
});
