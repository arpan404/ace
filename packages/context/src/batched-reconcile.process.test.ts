import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { GitWorkspace } from "./index.ts";
import { repository, run } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
/** Counts Git launches by subcommand: the I/O each watcher batch costs. */
async function countedRepository() {
  const repo = await repository();
  cleanups.push(repo.close);
  const launches: string[] = [];
  const workspace = new GitWorkspace(repo.root, 100_000, {
    spawn(options) {
      const args = options.args ?? [];
      launches.push(args.find((arg) => arg === "ls-files" || arg === "check-ignore") ?? "other");
      return spawnRawSupervised(options);
    },
  });
  const count = (command: string) => launches.filter((launched) => launched === command).length;
  return { repo, workspace, launches, count };
}

test("a hundred ignored build outputs reconcile with one Git ignore check", async () => {
  const { repo, workspace, launches, count } = await countedRepository();
  await repo.write(".gitignore", "dist/\n");
  await repo.write("src/main.ts", "main");
  await workspace.initialize();
  const outputs = Array.from({ length: 100 }, (_, i) => `dist/chunk-${i}.js`);
  for (const output of outputs) await repo.write(output, "built");
  await repo.write("src/fresh.ts", "fresh");
  launches.length = 0;
  await workspace.update([...outputs, ...outputs, "src/fresh.ts"]);
  expect(count("check-ignore")).toBe(1);
  expect(count("ls-files")).toBe(0);
  expect(workspace.index.complete("chunk")).toEqual([]);
  expect(workspace.index.complete("fresh")).toEqual(["src/fresh.ts"]);
});

test("ten changed folders reconcile with one set of subtree listings", async () => {
  const { repo, workspace, launches, count } = await countedRepository();
  await repo.write("keep.ts", "kept");
  await workspace.initialize();
  const folders = Array.from({ length: 10 }, (_, i) => `feature-${i}`);
  for (const folder of folders) await repo.write(`${folder}/deep/index.ts`, folder);
  launches.length = 0;
  await workspace.update([...folders, "feature-3/deep"]);
  expect(count("check-ignore")).toBe(1);
  expect(count("ls-files")).toBe(3);
  expect([...workspace.index.under("feature-7")]).toEqual(["feature-7/deep/index.ts"]);
  expect(workspace.index.complete("keep")).toEqual(["keep.ts"]);
});

test("one batch keeps tracked ignored, re-included, symlinked and unusual names correct", async () => {
  const { repo, workspace } = await countedRepository();
  const outside = await repository();
  cleanups.push(outside.close);
  await outside.write("secret.txt", "outside");
  await repo.write("tracked.secret", "tracked");
  await run("git", ["-C", repo.root, "add", "tracked.secret"]);
  await repo.write(".gitignore", "*.secret\n!keep.secret\n");
  await repo.write("gone.ts", "old");
  await workspace.initialize();
  const newline = "line\nbreak.ts";
  await repo.write("keep.secret", "kept");
  await repo.write("drop.secret", "dropped");
  await repo.write(newline, "newline");
  await repo.write(" leading space.ts", "space");
  await repo.write(":odd/inside.ts", "magic-looking folder");
  await repo.write("a[b]/glob.ts", "glob-looking folder");
  await repo.write("ab/sibling.ts", "sibling");
  await symlink(join(outside.root, "secret.txt"), join(repo.root, "link.ts"));
  await symlink(outside.root, join(repo.root, "linked"));
  await mkdir(join(repo.root, "empty"));
  await rm(join(repo.root, "gone.ts"));
  await workspace.update([
    "tracked.secret",
    "keep.secret",
    "drop.secret",
    newline,
    " leading space.ts",
    ":odd",
    "a[b]",
    "link.ts",
    "linked",
    "linked/secret.txt",
    "gone.ts",
    "../escape.ts",
  ]);
  const paths = [...workspace.index.under(".")].toSorted();
  expect(paths).toEqual(
    [
      " leading space.ts",
      ".gitignore",
      ":odd/inside.ts",
      "a[b]/glob.ts",
      "keep.secret",
      newline,
    ].toSorted(),
  );
  // The literal folder listing must not have swept in the glob-matching sibling.
  expect(workspace.index.complete("sibling")).toEqual([]);
});

test("a deleted folder and its descendants leave the index in the same batch", async () => {
  const { repo, workspace, count } = await countedRepository();
  await repo.write("old/a.ts", "a");
  await repo.write("old/inner/b.ts", "b");
  await workspace.initialize();
  await rm(join(repo.root, "old"), { recursive: true });
  await workspace.update(["old", "old/a.ts", "old/inner", "old/inner/b.ts"]);
  expect([...workspace.index.under(".")]).toEqual([]);
  expect(workspace.index.complete("old")).toEqual([]);
  // Nothing remained to ask Git about.
  expect(count("check-ignore")).toBe(0);
});

test("a file under an ignored folder whose name starts with a colon stays out of context", async () => {
  const { repo, workspace } = await countedRepository();
  await repo.write(".gitignore", ":odd/\n");
  await repo.write("src/main.ts", "main");
  await workspace.initialize();
  // Git reads a leading `:` as pathspec magic; checked as `odd/secret.txt` it looks visible.
  await repo.write(":odd/secret.txt", "token");
  await workspace.update([":odd/secret.txt"]);
  expect(workspace.index.complete("secret")).toEqual([]);
  await expect(workspace.read(":odd/secret.txt", 100)).rejects.toMatchObject({ code: "ignored" });
});

test("a file named like pathspec magic reconciles without failing its batch", async () => {
  const { repo, workspace } = await countedRepository();
  await repo.write("src/main.ts", "main");
  await workspace.initialize();
  await repo.write(":!x", "bang");
  await repo.write("src/fresh.ts", "fresh");
  await workspace.update([":!x", "src/fresh.ts"]);
  expect(workspace.index.complete("fresh")).toEqual(["src/fresh.ts"]);
  const read = await workspace.read(":!x", 100);
  expect(read.bytes.toString()).toBe("bang");
});
