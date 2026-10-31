import { expect, test } from "vitest";
import type { ThreadListEntry } from "@ace/protocol";
import { arrange, type HomeSort } from "./arrange.ts";
import { homeTree, recentGroupOf, standingReader } from "./home-tree.ts";
import { Organizer } from "./organizer.ts";
import { inboxFold, projectFold } from "./home-rows.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
// Saturday 31 October 2026, mid-afternoon.
const now = local(10, 31, 15);
const minute = 60_000;
const day = 24 * 60 * minute;

function tree(
  entries: readonly ThreadListEntry[],
  sortBy: HomeSort = "activity",
  settledCounts?: ReadonlyMap<string, number>,
) {
  const byId = new Map<string, ThreadListEntry>(entries.map((each) => [each.id, each]));
  return homeTree({
    arrangement: arrange(entries, { project: null, sortBy }, now),
    entry: (id) => byId.get(id),
    standing: standingReader({ baseline: 0, now }),
    sortBy,
    now,
    settledCounts,
  });
}

const projectOf = (built: ReturnType<typeof tree>, id: string) =>
  [...built.projects, ...built.quiet].find((place) => place.id === id);

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

test("a parent whose subagent still works is running, leads its project and is never done", () => {
  const built = tree([
    entry("newer", { state: "done" }, now - minute, { readAt: now }),
    entry("parent", { state: "done" }, now - day, {
      live: { runningSubagentCount: 1 },
      readAt: now,
    }),
  ]);
  expect(built.inbox).toEqual([]);
  expect(built.running).toEqual(["parent"]);
  expect(projectOf(built, "ace")?.threads).toEqual(["parent", "newer"]);
  expect(projectOf(built, "ace")?.running).toBe(1);
  expect(built.recent.map((item) => item.id)).toEqual(["newer"]);
});

test("Running lists working and background threads across projects", () => {
  const built = tree([
    entry("works", { state: "working", agents: 1 }, now, { workspaceId: "web" }),
    entry("serves", { state: "waiting", on: "background_task" }, now, { workspaceId: "ios" }),
    entry("rests", { state: "done" }, now, { readAt: now }),
  ]);
  expect(built.running.toSorted()).toEqual(["serves", "works"]);
});

test("pinned threads lead their project; Manual keeps the person's order below them", () => {
  const built = tree(
    [
      entry("b", { state: "done" }, now, { readAt: now, listOrder: 2 }),
      entry("works", { state: "working", agents: 1 }, now, { listOrder: 1 }),
      entry("pin", { state: "done" }, now - day, { readAt: now, pinned: true }),
    ],
    "manual",
  );
  expect(projectOf(built, "ace")?.threads).toEqual(["pin", "b", "works"]);
});

test("Recent holds work finished in the last 7 days, settled or done and seen, newest first", () => {
  const settled = { settledAt: now, readAt: now };
  const built = tree([
    entry("yesterday", { state: "done" }, now - day, settled),
    entry("old", { state: "done" }, now - 10 * day, settled),
    entry("seen", { state: "done" }, now - minute, { readAt: now }),
    entry("unseen", { state: "done" }, now - minute),
  ]);
  expect(built.recent.map((item) => item.id)).toEqual(["seen", "yesterday"]);
  // Done but unread is the Inbox's, never in both.
  expect(built.inbox).toEqual(["unseen"]);
});

test("a settled thread whose agent tree still runs never shows in Recent", () => {
  const built = tree([
    entry("busy", { state: "done" }, now - minute, {
      settledAt: now,
      readAt: now,
      live: { runningSubagentCount: 2 },
    }),
  ]);
  expect(built.recent).toEqual([]);
});

test("Recent groups by Today, Yesterday and Earlier this week", () => {
  expect(recentGroupOf(local(10, 31, 0), now)).toBe("today");
  expect(recentGroupOf(local(10, 30, 23), now)).toBe("yesterday");
  expect(recentGroupOf(local(10, 30, 0), now)).toBe("yesterday");
  expect(recentGroupOf(local(10, 26, 9), now)).toBe("week");
});

test("a project with only settled threads is quiet, with the daemon's count of them", () => {
  const built = tree(
    [
      entry("open", { state: "done" }, now, { readAt: now }),
      entry("old", { state: "done" }, now - day, { workspaceId: "docs", settledAt: now }),
    ],
    "activity",
    new Map([
      ["docs", 12],
      ["cli", 3],
    ]),
  );
  expect(built.projects.map((place) => place.id)).toEqual(["ace"]);
  expect(built.quiet.map((place) => [place.id, place.settledTotal])).toEqual([
    ["docs", 12],
    ["cli", 3],
  ]);
});

test("projects with open threads come by most recent activity", () => {
  const built = tree([
    entry("a", { state: "done" }, now - day, { readAt: now, workspaceId: "older" }),
    entry("b", { state: "done" }, now, { readAt: now, workspaceId: "newer" }),
  ]);
  expect(built.projects.map((place) => place.id)).toEqual(["newer", "older"]);
});

test("the panel remembers folded projects, open settled lists and Quiet projects", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const organizer = new Organizer(storage, now);
  expect(organizer.getState().quietOpen).toBe(false);
  organizer.setFolded(projectFold("ace"), true);
  organizer.setFolded(inboxFold, true);
  organizer.setSettledOpen("web", true);
  organizer.setQuietOpen(true);
  const reloaded = new Organizer(storage, now).getState();
  expect(reloaded.collapsed).toEqual([projectFold("ace"), inboxFold]);
  expect(reloaded.settledOpen).toEqual(["web"]);
  expect(reloaded.quietOpen).toBe(true);
  organizer.setFolded(projectFold("ace"), false);
  expect(new Organizer(storage, now).getState().collapsed).toEqual([inboxFold]);
});
