import { expect, test } from "vitest";
import type { ForgeActivity, ForgeCommit } from "@ace/protocol";
import {
  activityPageLimit,
  commitPageLimit,
  readActivityHistory,
  readCommitHistory,
  type ActivityHistory,
  type CommitHistory,
} from "./pr-history-pages.ts";

const event = (page: number): ForgeActivity => ({
  id: `e${page}`,
  event: "labeled",
  actor: "octo",
  at: null,
  raw: null,
});
const commit = (n: number): ForgeCommit => ({
  sha: n.toString(16).padStart(40, "0"),
  message: `Commit ${n}`,
  author: "octo",
  date: null,
  url: `https://github.com/acme/ace/commit/${n}`,
});

/** A timeline of `last` pages, one event each, answered when the test releases each read. */
function timeline(last: number, named = true) {
  const asked: number[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const read = async (page: number) => {
    asked.push(page);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return {
      events: [event(page)],
      ...(page < last ? { nextPage: page + 1 } : {}),
      ...(named ? { lastPage: last } : {}),
      truncated: false,
    };
  };
  return { read, asked, mostInFlight: () => mostInFlight };
}

test("a long timeline reads its newest page right after the first, then the rest a few at a time", async () => {
  const source = timeline(12);
  const progress: ActivityHistory[] = [];
  const history = await readActivityHistory(source.read, (partial) => progress.push(partial));
  expect(source.asked.slice(0, 2)).toEqual([1, 12]);
  expect(source.mostInFlight()).toBeGreaterThan(1);
  expect(source.mostInFlight()).toBeLessThanOrEqual(4);
  expect(history).toEqual({
    events: Array.from({ length: 12 }, (_, i) => event(i + 1)),
    truncated: false,
    complete: true,
  });
  // The first page shows before the rest, and the newest page is the next to join it.
  expect(progress[0]?.events).toEqual([event(1)]);
  expect(progress.find((p) => p.events.length === 2)?.events).toEqual([event(1), event(12)]);
  expect(progress.every((p) => !p.complete)).toBe(true);
});

test("a short timeline is one read", async () => {
  const source = timeline(1);
  const progress: ActivityHistory[] = [];
  const history = await readActivityHistory(source.read, (partial) => progress.push(partial));
  expect(source.asked).toEqual([1]);
  expect(progress).toEqual([]);
  expect(history).toEqual({ events: [event(1)], truncated: false, complete: true });
});

test("a timeline longer than ace reads keeps its first page and its newest pages, and says so", async () => {
  const last = activityPageLimit + 20;
  const source = timeline(last);
  const history = await readActivityHistory(source.read, () => {});
  expect(source.asked).toHaveLength(activityPageLimit);
  expect(history.truncated).toBe(true);
  expect(history.events[0]).toEqual(event(1));
  expect(history.events[1]).toEqual(event(22));
  expect(history.events.at(-1)).toEqual(event(last));
});

test("a timeline that names no last page is followed link by link", async () => {
  const source = timeline(3, false);
  const history = await readActivityHistory(source.read, () => {});
  expect(source.asked).toEqual([1, 2, 3]);
  expect(history.events).toEqual([event(1), event(2), event(3)]);
});

test("a failed timeline page fails the history and starts no further reads", async () => {
  const asked: number[] = [];
  const read = async (page: number) => {
    asked.push(page);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (page === 20) throw new Error("rate limited");
    return { events: [event(page)], lastPage: 20, truncated: false };
  };
  await expect(readActivityHistory(read, () => {})).rejects.toThrow("rate limited");
  expect(asked).toEqual([1, 20, 19, 18, 17]);
});

/** A PR whose commits fill `pages` pages of 100, newest page first. */
function commitPages(pages: number) {
  const cursors: (string | undefined)[] = [];
  const read = async (before: string | undefined) => {
    cursors.push(before);
    const index = before === undefined ? pages - 1 : Number(before) - 1;
    return {
      commits: Array.from({ length: 100 }, (_, n) => commit(index * 100 + n)),
      ...(index > 0 ? { before: String(index) } : {}),
      truncated: false,
    };
  };
  return { read, cursors };
}

test("a PR with hundreds of commits lists them all, oldest first, with the newest page shown first", async () => {
  const source = commitPages(5);
  const progress: CommitHistory[] = [];
  const history = await readCommitHistory(source.read, (partial) => progress.push(partial));
  expect(history.commits.map((c) => c.message)).toEqual(
    Array.from({ length: 500 }, (_, n) => `Commit ${n}`),
  );
  expect(history).toMatchObject({ truncated: false, complete: true });
  expect(source.cursors).toEqual([undefined, "4", "3", "2", "1"]);
  expect(progress[0]?.commits[0]?.message).toBe("Commit 400");
  expect(progress[0]?.commits).toHaveLength(100);
  expect(progress.every((p) => !p.complete)).toBe(true);
});

test("a commit list longer than ace reads keeps the newest commits and says so", async () => {
  const source = commitPages(commitPageLimit + 3);
  const history = await readCommitHistory(source.read, () => {});
  expect(source.cursors).toHaveLength(commitPageLimit);
  expect(history.truncated).toBe(true);
  expect(history.commits.at(-1)?.message).toBe(`Commit ${(commitPageLimit + 3) * 100 - 1}`);
});
