import { expect, test } from "vitest";
import { FilePatchCache } from "./git-diff-cache.ts";
import { diffPage } from "./git-diff-page.ts";

/** A stand-in for git: each read returns the file's current patch and is counted. */
function fakeGit(text: string) {
  const git = { text, reads: 0 };
  const load = async () => {
    git.reads++;
    return { patch: git.text, truncated: false };
  };
  return { git, load };
}

const patchOf = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `+line ${i + 1} of a long generated file`).join("\n");

test("every page of one version slices one read of git, however far into the file it is", async () => {
  const { git, load } = fakeGit(patchOf(40_000));
  const cache = new FilePatchCache(() => 0);
  const first = await cache.read("big", undefined, load);
  let offset = diffPage(first.patch, first.truncated, 0).nextOffset;
  let pages = 1;
  while (offset !== undefined) {
    const held = await cache.read("big", first.validator, load);
    offset = diffPage(held.patch, held.truncated, offset).nextOffset;
    pages++;
  }
  expect(pages).toBeGreaterThan(3);
  expect(git.reads).toBe(1);
});

test("a page at a version the file no longer has is refused once the held read expires", async () => {
  const { git, load } = fakeGit(patchOf(10));
  let now = 0;
  const cache = new FilePatchCache(() => now, { entries: 4, units: 1_000_000, ttlMs: 1000 });
  const first = await cache.read("file", undefined, load);
  git.text = patchOf(11);
  now = 500;
  expect((await cache.read("file", first.validator, load)).patch).toBe(patchOf(10));
  now = 2000;
  await expect(cache.read("file", first.validator, load)).rejects.toThrow("diff_changed");
  // The refused read still learned the new version, so its pages need no further read.
  const fresh = await cache.read("file", undefined, load);
  expect(fresh.validator).not.toBe(first.validator);
  const reads = git.reads;
  expect((await cache.read("file", fresh.validator, load)).patch).toBe(patchOf(11));
  expect(git.reads).toBe(reads);
});

test("held reads stay within their entry and size bounds, dropping the oldest first", async () => {
  const cache = new FilePatchCache(() => 0, { entries: 2, units: 250, ttlMs: 60_000 });
  const files = new Map([
    ["a", fakeGit("a".repeat(100))],
    ["b", fakeGit("b".repeat(100))],
    ["c", fakeGit("c".repeat(100))],
  ]);
  const validators = new Map<string, string>();
  for (const [key, { load }] of files)
    validators.set(key, (await cache.read(key, undefined, load)).validator);
  // "a" was dropped for "c"; "b" and "c" are still held.
  for (const key of ["b", "c", "a"]) {
    const file = files.get(key);
    if (!file) throw new Error(key);
    await cache.read(key, validators.get(key), file.load);
  }
  expect([...files.values()].map(({ git }) => git.reads)).toEqual([2, 1, 1]);
});
