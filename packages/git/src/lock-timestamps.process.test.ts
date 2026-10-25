import { access, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clearLeftoverLocks } from "./git-locks.ts";
import type { GitProcess } from "./git-processes.ts";
import { git, scratch } from "./test-repo.ts";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A repository holding an `index.lock` whose mtime reads `stamp`, as its filesystem stored it. */
async function lockedRepository(stamp: number) {
  const repo = await scratch();
  await git(repo, "init", "--initial-branch=main");
  const lock = join(repo, ".git", "index.lock");
  await writeFile(lock, "");
  await utimes(lock, new Date(stamp), new Date(stamp));
  return { repo, lock };
}

// A minute ago, on a whole even second: how a 2-second-resolution filesystem stamps a write.
const stamp = Math.floor((Date.now() - 60_000) / 2000) * 2000;
const later = new Date(Date.now() + 60_000);

test("a lock on a coarse-timestamp filesystem stays while a writer that started after its stamp is alive", async () => {
  const { repo, lock } = await lockedRepository(stamp);
  // The writer started 1.8 s after the stored stamp and wrote the lock at 1.9 s; the filesystem
  // rounded that write down.
  const writer: GitProcess = { pid: 1, cwd: repo, checkout: repo, startedAt: stamp + 1800 };
  expect(await clearLeftoverLocks(repo, async () => [writer], later)).toEqual([]);
  expect(await exists(lock)).toBe(true);
});

test("a lock no live Git could have written goes, even while a Git that started well after it reads the checkout", async () => {
  const { repo, lock } = await lockedRepository(stamp);
  const reader: GitProcess = { pid: 1, cwd: repo, checkout: repo, startedAt: stamp + 30_000 };
  expect(await clearLeftoverLocks(repo, async () => [reader], later)).toEqual([lock]);
  expect(await exists(lock)).toBe(false);
});

test("a lock stays while a Git process whose start can't be read works in the checkout", async () => {
  const { repo, lock } = await lockedRepository(stamp);
  const unknown: GitProcess = { pid: 1, cwd: repo, checkout: repo };
  expect(await clearLeftoverLocks(repo, async () => [unknown], later)).toEqual([]);
  expect(await exists(lock)).toBe(true);
});
