import type { FileBlameResult } from "@ace/git";
import { expect, test } from "vitest";
import { GitBlameCache } from "./git-blame-cache.ts";

function sampleBlame(head: string, line: number): FileBlameResult {
  return {
    head,
    commits: [
      {
        sha: head,
        shortSha: head.slice(0, 7),
        subject: `Commit ${line}`,
        authorName: "Arpan",
        authorEmail: "arpan@example.invalid",
        authoredAt: 1_700_000_000_000,
      },
    ],
    lines: [{ line, sha: head }],
    capped: false,
  };
}

test("GitBlameCache reuses fresh entries, expires after ttl, and evicts oldest past capacity", async () => {
  let now = 1_000;
  const cache = new GitBlameCache(() => now, { entries: 2, ttlMs: 500 });
  let loads = 0;

  const first = await cache.read("a", async () => {
    loads++;
    return sampleBlame("a".repeat(40), 1);
  });
  const cached = await cache.read("a", async () => {
    loads++;
    return sampleBlame("b".repeat(40), 2);
  });
  expect(loads).toBe(1);
  expect(cached).toEqual(first);

  // Touching "a" refreshes LRU order so "b" is evicted when "c" arrives.
  await cache.read("b", async () => {
    loads++;
    return sampleBlame("b".repeat(40), 2);
  });
  await cache.read("a", async () => {
    loads++;
    return sampleBlame("x".repeat(40), 9);
  });
  expect(loads).toBe(2);

  await cache.read("c", async () => {
    loads++;
    return sampleBlame("c".repeat(40), 3);
  });
  expect(loads).toBe(3);

  // "b" was evicted, so it reloads; "a" stayed live.
  await cache.read("a", async () => {
    loads++;
    return sampleBlame("x".repeat(40), 9);
  });
  expect(loads).toBe(3);

  await cache.read("b", async () => {
    loads++;
    return sampleBlame("b".repeat(40), 2);
  });
  expect(loads).toBe(4);

  // Advancing past TTL forces a reload.
  now += 600;
  await cache.read("b", async () => {
    loads++;
    return sampleBlame("d".repeat(40), 4);
  });
  expect(loads).toBe(5);
});

test("GitBlameCache deduplicates concurrent reads and does not cache failures", async () => {
  const cache = new GitBlameCache(() => 1_000);
  let loads = 0;
  const gate = Promise.withResolvers<FileBlameResult>();

  const p1 = cache.read("k", () => {
    loads++;
    return gate.promise;
  });
  const p2 = cache.read("k", () => {
    loads++;
    return gate.promise;
  });
  expect(loads).toBe(1);
  const value = sampleBlame("1".repeat(40), 1);
  gate.resolve(value);
  expect(await Promise.all([p1, p2])).toEqual([value, value]);

  await expect(
    cache.read("fail", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  const recovered = await cache.read("fail", async () => sampleBlame("2".repeat(40), 2));
  expect(recovered.lines[0]?.line).toBe(2);
});
