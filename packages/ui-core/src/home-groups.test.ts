import { expect, test } from "vitest";
import {
  activeGroups,
  createdGroups,
  dayGroupOf,
  homeLane,
  manualGroups,
  type LaneInput,
} from "./home-groups.ts";
import { Organizer } from "./organizer.ts";
import { threadMatches } from "./thread-match.ts";
import { entry } from "./test-entries.fixture.ts";

const local = (month: number, date: number, hour = 12) =>
  new Date(2026, month - 1, date, hour).getTime();
// Saturday 31 October 2026, mid-afternoon.
const now = local(10, 31, 15);
const lanes: LaneInput = { baseline: 0, now };
const group = (entries: Parameters<typeof activeGroups>[0]) =>
  activeGroups(entries, (each) => homeLane(each, lanes), now);

test("a thread waiting on the person lands under Needs you, not under its day", () => {
  const groups = group([
    entry("asks", { state: "needs_you", interactions: 1 }, now - 60_000),
    entry("done", { state: "done" }, now - 60_000, { readAt: now }),
  ]);
  expect(groups["needs-you"]).toEqual(["asks"]);
  expect(groups.today).toEqual(["done"]);
});

test("an unseen failure needs the person; a failure already seen rests under its day", () => {
  const groups = group([
    entry("unseen", { state: "failed" }, now - 60_000),
    entry("seen", { state: "failed" }, now - 60_000, { readAt: now }),
  ]);
  expect(groups["needs-you"]).toEqual(["unseen"]);
  expect(groups.today).toEqual(["seen"]);
});

test("a parent whose subagent still works stays under Running, never under a day", () => {
  const groups = group([
    entry("parent", { state: "done" }, local(10, 20), {
      live: { runningSubagentCount: 1 },
      readAt: now,
    }),
    entry("working", { state: "working", agents: 1 }, local(10, 20)),
    entry("background", { state: "waiting", on: "background_task" }, local(10, 20)),
  ]);
  expect(groups.running).toEqual(["parent", "working", "background"]);
  expect(groups.earlier).toEqual([]);
});

test("threads at rest fall into Today, Yesterday, This week and Earlier by last activity", () => {
  expect(dayGroupOf(local(10, 31, 0), now)).toBe("today");
  expect(dayGroupOf(local(10, 30, 23), now)).toBe("yesterday");
  expect(dayGroupOf(local(10, 30, 0), now)).toBe("yesterday");
  // Monday of this week.
  expect(dayGroupOf(local(10, 26, 1), now)).toBe("week");
  // Sunday of last week.
  expect(dayGroupOf(local(10, 25, 23), now)).toBe("earlier");
  // Activity stamped a moment ahead of this clock is still today.
  expect(dayGroupOf(now + 5_000, now)).toBe("today");
});

test("on a Monday, yesterday is Yesterday rather than part of an earlier week", () => {
  const monday = local(10, 26, 9);
  expect(dayGroupOf(local(10, 25, 20), monday)).toBe("yesterday");
  expect(dayGroupOf(local(10, 24, 20), monday)).toBe("earlier");
});

test("each group keeps the order it was given", () => {
  const groups = group([
    entry("b", { state: "done" }, local(10, 31, 9), { readAt: now }),
    entry("a", { state: "done" }, local(10, 31, 14), { readAt: now }),
  ]);
  expect(groups.today).toEqual(["b", "a"]);
});

test("the Threads panel remembers its tab and folded groups across reloads", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const organizer = new Organizer(storage, now);
  expect(organizer.getState().homeTab).toBe("active");
  organizer.setHomeTab("settled");
  organizer.setGroupOpen("today", false);
  const reloaded = new Organizer(storage, now).getState();
  expect(reloaded.homeTab).toBe("settled");
  expect(reloaded.collapsed).toEqual(["today"]);
  organizer.setGroupOpen("today", true);
  expect(new Organizer(storage, now).getState().collapsed).toEqual([]);
});

test("search matches every word against title, project, branch and pull request", () => {
  const thread = entry("x", { state: "done" }, now, {
    title: "Persist explorer tree state",
    details: { branch: "ace/persist-explorer", linkedPr: { number: 1536, state: "open" } },
  });
  expect(threadMatches(thread, "explorer", "ace-web")).toBe(true);
  expect(threadMatches(thread, "web tree", "ace-web")).toBe(true);
  expect(threadMatches(thread, "#1536", "ace-web")).toBe(true);
  expect(threadMatches(thread, "persist-explorer", "ace-web")).toBe(true);
  expect(threadMatches(thread, "ios", "ace-web")).toBe(false);
  expect(threadMatches(thread, "  ", "ace-web")).toBe(true);
});

test("sorted newest first, threads fall by the day they were created, whoever needs you", () => {
  const groups = createdGroups(
    [
      entry("new-asks", { state: "needs_you", interactions: 1 }, now, { createdAt: now - 60_000 }),
      entry("old-works", { state: "working", agents: 1 }, now, { createdAt: local(10, 1) }),
    ],
    now,
  );
  expect(groups.today).toEqual(["new-asks"]);
  expect(groups.earlier).toEqual(["old-works"]);
  expect(groups["needs-you"]).toEqual([]);
  expect(groups.running).toEqual([]);
});

test("sorted by hand, every thread stays in one list in the person's order", () => {
  const groups = manualGroups([
    entry("b", { state: "working", agents: 1 }, now),
    entry("a", { state: "needs_you", interactions: 1 }, now),
  ]);
  expect(groups.listed).toEqual(["b", "a"]);
  expect(groups["needs-you"]).toEqual([]);
});
