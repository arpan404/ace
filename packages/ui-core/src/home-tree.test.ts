import { expect, test } from "vitest";
import type { ThreadListEntry } from "@ace/protocol";
import { arrange, type HomeSort } from "./arrange.ts";
import { homeTree, keepSettledMs, standingReader, type KeepSettled } from "./home-tree.ts";
import { Organizer } from "./organizer.ts";
import { projectFold } from "./home-rows.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
// Saturday 31 October 2026, mid-afternoon.
const now = local(10, 31, 15);
const minute = 60_000;
const day = 24 * 60 * minute;

function tree(
  entries: readonly ThreadListEntry[],
  options: {
    sortBy?: HomeSort;
    keep?: KeepSettled;
    settledCounts?: ReadonlyMap<string, number>;
  } = {},
) {
  const sortBy = options.sortBy ?? "activity";
  const byId = new Map<string, ThreadListEntry>(entries.map((each) => [each.id, each]));
  return homeTree({
    arrangement: arrange(entries, { project: null, sortBy }, now),
    entry: (id) => byId.get(id),
    standing: standingReader({ baseline: 0, now }),
    sortBy,
    now,
    graceMs: keepSettledMs(options.keep ?? "3d"),
    settledCounts: options.settledCounts,
  });
}

const projectOf = (built: ReturnType<typeof tree>, id: string) =>
  built.projects.find((place) => place.id === id);

test("a thread waiting on approval is in the Inbox, not under its project", () => {
  const built = tree([
    entry("asks", { state: "needs_you", interactions: 1 }, now - minute),
    entry("rests", { state: "done" }, now - 2 * minute, { readAt: now }),
  ]);
  expect(built.inbox).toEqual(["asks"]);
  expect(projectOf(built, "ace")?.threads).toEqual(["rests"]);
  expect(projectOf(built, "ace")?.inbox).toBe(1);
});

test("finished work leaves the Inbox for its project once the person has opened it", () => {
  const unseen = entry("done", { state: "done" }, now - minute);
  expect(tree([unseen]).inbox).toEqual(["done"]);
  const opened = entry("done", { state: "done" }, now - minute, { readAt: now });
  const built = tree([opened]);
  expect(built.inbox).toEqual([]);
  expect(projectOf(built, "ace")?.threads).toEqual(["done"]);
});

test("an unseen failure is in the Inbox; one already seen rests in its project", () => {
  const built = tree([
    entry("unseen", { state: "failed" }, now - minute),
    entry("seen", { state: "failed" }, now - minute, { readAt: now }),
  ]);
  expect(built.inbox).toEqual(["unseen"]);
  expect(projectOf(built, "ace")?.threads).toEqual(["seen"]);
});

test("the Inbox lists its threads newest first", () => {
  const built = tree([
    entry("older", { state: "needs_you", interactions: 1 }, now - day),
    entry("newer", { state: "done" }, now - minute, { workspaceId: "web" }),
  ]);
  expect(built.inbox).toEqual(["newer", "older"]);
});

test("a waiting approval never appears in its project, even when it settled first", () => {
  const built = tree([
    entry("asks", { state: "needs_you", interactions: 1 }, now - minute, {
      settledAt: now - day,
      settledReason: "manual",
    }),
  ]);
  expect(built.inbox).toEqual(["asks"]);
  expect(projectOf(built, "ace")?.threads).toEqual([]);
  expect(projectOf(built, "ace")?.recent).toEqual([]);
  expect(built.settled).toEqual([]);
});

test("a thread settled 2 days ago stays in its project with 3 days, and moves to History with 1", () => {
  const settled = entry("settled", { state: "done" }, now - 3 * day, {
    readAt: now - 3 * day,
    settledAt: now - 2 * day,
  });
  const three = tree([settled], { keep: "3d" });
  expect(projectOf(three, "ace")?.recent).toEqual(["settled"]);
  expect(three.settled).toEqual(["settled"]);

  const one = tree([settled], { keep: "1d" });
  expect(projectOf(one, "ace")).toBeUndefined();
  expect(one.quiet).toEqual(["ace"]);
  expect(one.settled).toEqual(["settled"]);

  // Moved to History right away: never in the project.
  expect(projectOf(tree([settled], { keep: "0d" }), "ace")).toBeUndefined();
});

test("a parent whose subagent still works is running, leads its project and is never settled", () => {
  const built = tree([
    entry("newer", { state: "done" }, now - minute, { readAt: now }),
    entry("parent", { state: "done" }, now - day, {
      live: { runningSubagentCount: 1 },
      readAt: now,
      settledAt: now - 10 * day,
    }),
  ]);
  expect(built.inbox).toEqual([]);
  expect(projectOf(built, "ace")?.threads).toEqual(["parent", "newer"]);
  expect(projectOf(built, "ace")?.running).toBe(1);
  expect(projectOf(built, "ace")?.recent).toEqual([]);
  // Not at rest, so History doesn't list it either.
  expect(built.settled).toEqual([]);
});

test("pinned threads lead their project; Manual keeps the person's order below them", () => {
  const built = tree(
    [
      entry("b", { state: "done" }, now, { readAt: now, listOrder: 2 }),
      entry("works", { state: "working", agents: 1 }, now, { listOrder: 1 }),
      entry("pin", { state: "done" }, now - day, { readAt: now, pinned: true }),
    ],
    { sortBy: "manual" },
  );
  expect(projectOf(built, "ace")?.threads).toEqual(["pin", "b", "works"]);
});

test("a project with nothing open or recently settled is quiet, as is one only the daemon knows", () => {
  const built = tree(
    [
      entry("open", { state: "done" }, now, { readAt: now }),
      entry("old", { state: "done" }, now - 9 * day, {
        workspaceId: "docs",
        readAt: now - 9 * day,
        settledAt: now - 8 * day,
      }),
    ],
    {
      settledCounts: new Map([
        ["docs", 12],
        ["cli", 3],
      ]),
    },
  );
  expect(built.projects.map((place) => place.id)).toEqual(["ace"]);
  expect(built.quiet).toEqual(["docs", "cli"]);
});

test("a project whose only threads wait in the Inbox stays listed", () => {
  const built = tree([entry("asks", { state: "needs_you", interactions: 1 }, now)]);
  expect(built.projects.map((place) => [place.id, place.inbox])).toEqual([["ace", 1]]);
});

test("projects come by most recent activity", () => {
  const built = tree([
    entry("a", { state: "done" }, now - day, { readAt: now, workspaceId: "older" }),
    entry("b", { state: "done" }, now, { readAt: now, workspaceId: "newer" }),
  ]);
  expect(built.projects.map((place) => place.id)).toEqual(["newer", "older"]);
});

test("the panel remembers folded projects and Quiet projects", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const organizer = new Organizer(storage, now);
  expect(organizer.getState().quietOpen).toBe(false);
  organizer.setFolded(projectFold("ace"), true);
  organizer.setFolded(projectFold("web"), true);
  organizer.setQuietOpen(true);
  const reloaded = new Organizer(storage, now).getState();
  expect(reloaded.collapsed).toEqual([projectFold("ace"), projectFold("web")]);
  expect(reloaded.quietOpen).toBe(true);
  organizer.setFolded(projectFold("ace"), false);
  expect(new Organizer(storage, now).getState().collapsed).toEqual([projectFold("web")]);
});
