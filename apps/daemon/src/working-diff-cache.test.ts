import { expect, test } from "vitest";
import { WorkingDiffCache, type WorkingDiff } from "./working-diff-cache.ts";

/** A checkout whose diff is whatever was last written to it, counting how often git ran. */
function checkout(patch: string) {
  const state = { patch, reads: 0 };
  return {
    state,
    load: async (): Promise<WorkingDiff> => {
      state.reads++;
      return { patch: state.patch, truncated: false };
    },
  };
}

test("an unchanged checkout is answered without reading git again", async () => {
  const cache = new WorkingDiffCache();
  const repo = checkout("+one");
  expect((await cache.read("/repo", "stamp-1", repo.load)).patch).toBe("+one");
  repo.state.patch = "+stale if served";
  expect((await cache.read("/repo", "stamp-1", repo.load)).patch).toBe("+one");
});

test("a changed checkout reads git again and shows the new diff", async () => {
  const cache = new WorkingDiffCache();
  const repo = checkout("+one");
  await cache.read("/repo", "stamp-1", repo.load);
  repo.state.patch = "+two";
  expect((await cache.read("/repo", "stamp-2", repo.load)).patch).toBe("+two");
});

test("a checkout without a stamp is read every time", async () => {
  const cache = new WorkingDiffCache();
  const repo = checkout("+one");
  await cache.read("/repo", undefined, repo.load);
  repo.state.patch = "+two";
  expect((await cache.read("/repo", undefined, repo.load)).patch).toBe("+two");
});

test("requests at the same stamp arriving together share one read", async () => {
  const cache = new WorkingDiffCache();
  const repo = checkout("+one");
  const [first, second] = await Promise.all([
    cache.read("/repo", "stamp-1", repo.load),
    cache.read("/repo", "stamp-1", repo.load),
  ]);
  expect(first.patch).toBe("+one");
  expect(second.patch).toBe("+one");
  expect(repo.state.reads).toBe(1);
});

test("one checkout's diff is never served for another", async () => {
  const cache = new WorkingDiffCache();
  await cache.read("/a", "same-stamp", checkout("+a").load);
  expect((await cache.read("/b", "same-stamp", checkout("+b").load)).patch).toBe("+b");
});

test("a failed read is not kept: the next request reads again", async () => {
  const cache = new WorkingDiffCache();
  await expect(
    cache.read("/repo", "stamp-1", () => Promise.reject(new Error("git_failed"))),
  ).rejects.toThrow("git_failed");
  expect((await cache.read("/repo", "stamp-1", checkout("+one").load)).patch).toBe("+one");
});
