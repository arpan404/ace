import { expect, test } from "vitest";
import type { ThreadListEntry } from "@ace/protocol";
import { arrange, type HomeSort } from "./arrange.ts";
import { homeTree, standingReader } from "./home-tree.ts";
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
    settledCounts?: ReadonlyMap<string, number>;
    projects?: readonly string[];
  } = {},
) {
  const sortBy = options.sortBy ?? "activity";
  const byId = new Map<string, ThreadListEntry>(entries.map((each) => [each.id, each]));
  return homeTree({
    arrangement: arrange(entries, { project: null, sortBy }, now),
    entry: (id) => byId.get(id),
    standing: standingReader({ baseline: 0, now }),
    sortBy,
    settledCounts: options.settledCounts,
    projects: options.projects,
  });
}

const projectOf = (built: ReturnType<typeof tree>, id: string) =>
  built.projects.find((place) => place.id === id);

/** Settled by the daemon a while ago, read, at rest. */
const settledAt = (at: number) => ({ readAt: at, settledAt: at, settledReason: "manual" });

test("an approval leads Active, ahead of newer working and finished threads", () => {
  const built = tree([
    entry("done", { state: "done" }, now, { readAt: now }),
    entry("works", { state: "working", agents: 1 }, now - minute),
    entry("asks", { state: "needs_you", interactions: 1 }, now - day),
  ]);
  expect(built.active).toEqual(["asks", "works", "done"]);
});

test("sorted newest first, Active keeps the person's sort, not live state", () => {
  const built = tree(
    [
      entry("asks", { state: "needs_you", interactions: 1 }, now, { createdAt: 1 }),
      entry("new", { state: "done" }, now - day, { readAt: now, createdAt: 3 }),
    ],
    { sortBy: "created" },
  );
  expect(built.active).toEqual(["new", "asks"]);
});

test("an unseen failure needs the person and leads Active; one already seen waits with the rest", () => {
  const built = tree([
    entry("seen", { state: "failed" }, now, { readAt: now }),
    entry("works", { state: "working", agents: 1 }, now),
    entry("unseen", { state: "failed" }, now - day),
  ]);
  expect(built.active).toEqual(["unseen", "works", "seen"]);
});

test("a working thread is in Active, not in its project", () => {
  const built = tree([entry("works", { state: "working", agents: 1 }, now - minute)]);
  expect(built.active).toEqual(["works"]);
  expect(projectOf(built, "ace")).toEqual({ id: "ace", settled: [], active: 1, held: 0 });
});

test("a settled thread is in its project, not in Active", () => {
  const built = tree([entry("rests", { state: "done" }, now - day, settledAt(now - day))]);
  expect(built.active).toEqual([]);
  expect(projectOf(built, "ace")?.settled).toEqual(["rests"]);
  expect(built.settled).toEqual(["rests"]);
});

test("settling a thread moves it from Active into its project", () => {
  const open = entry("t", { state: "done" }, now - minute, { readAt: now });
  expect(tree([open]).active).toEqual(["t"]);
  const settled = entry("t", { state: "done" }, now - minute, settledAt(now));
  const after = tree([settled]);
  expect(after.active).toEqual([]);
  expect(projectOf(after, "ace")?.settled).toEqual(["t"]);
});

test("a settled parent whose subagent still works is Active, never in its project or History", () => {
  const built = tree([
    entry("parent", { state: "done" }, now - day, {
      live: { runningSubagentCount: 1 },
      ...settledAt(now - 10 * day),
    }),
  ]);
  expect(built.active).toEqual(["parent"]);
  expect(projectOf(built, "ace")?.settled).toEqual([]);
  expect(built.settled).toEqual([]);
});

test("a waiting approval that settled first is Active, never in its project", () => {
  const built = tree([
    entry("asks", { state: "needs_you", interactions: 1 }, now - minute, settledAt(now - day)),
  ]);
  expect(built.active).toEqual(["asks"]);
  expect(projectOf(built, "ace")?.settled).toEqual([]);
});

test("finished work not yet opened stays in Active until it settles", () => {
  const built = tree([entry("unread", { state: "done" }, now - minute)]);
  expect(built.active).toEqual(["unread"]);
});

test("Active spans projects, pinned threads first in the person's order", () => {
  const built = tree([
    entry("asks", { state: "needs_you", interactions: 1 }, now, { workspaceId: "web" }),
    entry("pin", { state: "done" }, now - day, { readAt: now, pinned: true }),
  ]);
  expect(built.active).toEqual(["pin", "asks"]);
});

test("a pinned thread the person settled rests in its project", () => {
  const built = tree([
    entry("pin", { state: "done" }, now - day, { pinned: true, ...settledAt(now - day) }),
  ]);
  expect(built.active).toEqual([]);
  expect(projectOf(built, "ace")?.settled).toEqual(["pin"]);
});

test("a project's settled threads come newest first", () => {
  const built = tree([
    entry("old", { state: "done" }, now - 5 * day, settledAt(now - 5 * day)),
    entry("new", { state: "done" }, now - day, settledAt(now - day)),
  ]);
  expect(projectOf(built, "ace")?.settled).toEqual(["new", "old"]);
});

test("a project known only from the daemon's count is listed, its threads in History", () => {
  const built = tree([], { settledCounts: new Map([["docs", 12]]) });
  expect(built.projects).toEqual([{ id: "docs", settled: [], active: 0, held: 12 }]);
});

test("only projects with no thread at all are quiet", () => {
  const built = tree([entry("works", { state: "working", agents: 1 }, now)], {
    settledCounts: new Map([["docs", 3]]),
    projects: ["ace", "cli", "docs"],
  });
  expect(built.projects.map((place) => place.id).toSorted()).toEqual(["ace", "docs"]);
  expect(built.quiet).toEqual(["cli"]);
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

/** Delegated here by an agent on a paired machine, whose thread is its parent. */
const fromPairedMachine = {
  hasSentMessage: true,
  delegatedFrom: { hostId: "host-a", hostName: "Studio Mac", threadId: "parent-on-a" },
};

test("a thread delegated from a paired machine is not listed as a top-level thread on the host", () => {
  const built = tree([
    entry("mine", { state: "working", agents: 1 }, now - minute),
    entry("asked", { state: "needs_you", interactions: 1 }, now, fromPairedMachine),
    entry("rested", { state: "done" }, now - day, { ...fromPairedMachine, ...settledAt(now) }),
  ]);
  expect(built.active).toEqual(["mine"]);
  expect(built.order).toEqual(["mine"]);
  expect(built.settled).toEqual([]);
  expect(projectOf(built, "ace")).toMatchObject({ active: 1, settled: [] });
});
