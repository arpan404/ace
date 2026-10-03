import { expect, test } from "vitest";
import { arrange, projectCounts } from "./arrange.ts";
import type { OrganizerState, ThreadMark } from "./organizer.ts";
import { entry } from "./test-entries.fixture.ts";

const hour = 3_600_000;
const now = 10 * 24 * hour;
const state = (
  marks: Record<string, ThreadMark> = {},
  patch: Partial<OrganizerState> = {},
): OrganizerState => ({
  baseline: 0,
  autoSettle: "1d",
  project: null,
  settledOpen: false,
  marks,
  archiving: new Set(),
  ...patch,
});

test("Home puts threads that need you first, then moving ones, then trouble, then the rest", () => {
  const entries = [
    entry("done", { state: "done" }, now - hour),
    entry("failed", { state: "failed" }, now - hour),
    entry("working", { state: "working", agents: 1 }, now - hour),
    entry("asks", { state: "needs_you", interactions: 1 }, now - 2 * hour),
  ];
  expect(arrange(entries, state(), now).active).toEqual(["asks", "working", "failed", "done"]);
});

test("a thread held by a provider limit stays with the moving ones, above trouble", () => {
  const entries = [
    entry("failed", { state: "failed" }, now - hour),
    entry("done", { state: "done" }, now - hour),
    entry("limited", { state: "limited", until: now + hour }, now - 2 * hour),
  ];
  expect(arrange(entries, state(), now).active).toEqual(["limited", "failed", "done"]);
});

test("within a group pinned threads lead, then the most recently active", () => {
  const entries = [
    entry("older", { state: "working", agents: 1 }, now - 3 * hour),
    entry("newer", { state: "working", agents: 1 }, now - hour),
    entry("pinned", { state: "working", agents: 1 }, now - 5 * hour),
  ];
  const { active } = arrange(entries, state({ pinned: { pinned: true } }), now);
  expect(active).toEqual(["pinned", "newer", "older"]);
});

test("a snoozed thread sinks below everything until it wakes", () => {
  const entries = [
    entry("asks", { state: "needs_you", interactions: 1 }, now),
    entry("done", { state: "done" }, now),
  ];
  const marks = { asks: { snoozedUntil: now + hour } };
  expect(arrange(entries, state(marks), now).active).toEqual(["done", "asks"]);
  expect(arrange(entries, state(marks), now + 2 * hour).active).toEqual(["asks", "done"]);
});

test("a finished thread settles after a quiet day; one that needs you never does", () => {
  const entries = [
    entry("quiet", { state: "done" }, now - 2 * 24 * hour),
    entry("fresh", { state: "done" }, now - hour),
    entry("asks", { state: "needs_you", interactions: 1 }, now - 5 * 24 * hour),
  ];
  const result = arrange(entries, state(), now);
  expect(result.settled).toEqual(["quiet"]);
  expect(result.active).toEqual(["asks", "fresh"]);
  expect(arrange(entries, state({}, { autoSettle: "never" }), now).settled).toEqual([]);
});

test("a thread settled by hand comes back when it moves again", () => {
  const settledAt = now - hour;
  const marks = { t: { settledAt } };
  expect(arrange([entry("t", { state: "done" }, settledAt)], state(marks), now).settled).toEqual([
    "t",
  ]);
  const moved = entry("t", { state: "working", agents: 1 }, now);
  expect(arrange([moved], state(marks), now).active).toEqual(["t"]);
});

test("archived, archiving and deleted threads leave Home and its project counts", () => {
  const entries = [
    entry("kept", { state: "done" }, now, { workspaceId: "web" }),
    entry("archived", { state: "done" }, now, { archivedAt: now }),
    entry("archiving", { state: "done" }, now),
    entry("deleted", { state: "done" }, now),
  ];
  const organised = state({ deleted: { deleted: true } }, { archiving: new Set(["archiving"]) });
  expect(arrange(entries, organised, now).active).toEqual(["kept"]);
  expect(projectCounts(entries, organised)).toEqual([{ id: "web", threads: 1 }]);
});

test("the project filter keeps only that project's threads", () => {
  const entries = [
    entry("a", { state: "done" }, now, { workspaceId: "ace" }),
    entry("w", { state: "done" }, now, { workspaceId: "web" }),
  ];
  expect(arrange(entries, state({}, { project: "web" }), now).active).toEqual(["w"]);
});
