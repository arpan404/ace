import { expect, test } from "vitest";
import { arrange, homeMachine, projectCounts } from "./arrange.ts";
import { isUnread } from "./thread-state.ts";
import type { OrganizerState } from "./organizer.ts";
import { entry } from "./test-entries.fixture.ts";

const hour = 3_600_000;
const now = 10 * 24 * hour;
const state = (patch: Partial<OrganizerState> = {}): OrganizerState => ({
  baseline: 0,
  project: null,
  settledOpen: false,
  ...patch,
});

test("Home puts requests first, working next, then every other task by recency", () => {
  const entries = [
    entry("done", { state: "done" }, now - hour),
    entry("failed", { state: "failed" }, now - hour),
    entry("working", { state: "working", agents: 1 }, now - hour),
    entry("asks", { state: "needs_you", interactions: 1 }, now - 2 * hour),
  ];
  const order = arrange(entries, state(), now);
  expect(order.active).toEqual(["asks", "working"]);
  expect(order.recent).toEqual(["done", "failed"]);
});

test("waiting and failed tasks follow working tasks by recency", () => {
  const entries = [
    entry("failed", { state: "failed" }, now - hour),
    entry("done", { state: "done" }, now - hour),
    entry("limited", { state: "limited", until: now + hour }, now - 2 * hour),
  ];
  expect(arrange(entries, state(), now).recent).toEqual(["failed", "done", "limited"]);
});

test("pinned threads leave Home order for their own, in the place the person gave each", () => {
  const entries = [
    entry("asks", { state: "needs_you", interactions: 1 }, now),
    entry("second", { state: "done" }, now - 5 * hour, { pinned: true, pinOrder: 20 }),
    entry("first", { state: "working", agents: 1 }, now - 9 * hour, { pinned: true, pinOrder: 30 }),
    entry("legacy", { state: "needs_you", interactions: 1 }, now, { pinned: true }),
  ];
  const order = arrange(entries, state(), now);
  // A pin from before places existed has none, so it goes last among the pinned.
  expect(order.pinned).toEqual(["first", "second", "legacy"]);
  expect(order.active).toEqual(["asks"]);
});

test("a pinned thread stays pinned when settled, and leaves with an archive", () => {
  const entries = [
    entry("kept", { state: "done" }, now, { pinned: true, pinOrder: 1, settledAt: now }),
    entry("gone", { state: "done" }, now, { pinned: true, pinOrder: 2, archivedAt: now }),
  ];
  const order = arrange(entries, state(), now);
  expect(order.pinned).toEqual(["kept"]);
  expect(order.settled).toEqual([]);
});

test("pinned threads with the same place keep a steady order: most recent work, then id", () => {
  const entries = [
    entry("b", { state: "done" }, now - hour, { pinned: true, pinOrder: 5 }),
    entry("a", { state: "done" }, now - hour, { pinned: true, pinOrder: 5 }),
    entry("fresh", { state: "done" }, now, { pinned: true, pinOrder: 5 }),
  ];
  expect(arrange(entries, state(), now).pinned).toEqual(["fresh", "a", "b"]);
});

test("recency is the last work, so renaming or pinning a thread doesn't move it up", () => {
  const entries = [
    entry("worked", { state: "done" }, now - 2 * hour, { activityAt: now - 2 * hour }),
    entry("renamed", { state: "done" }, now, { activityAt: now - 5 * hour }),
  ];
  expect(arrange(entries, state(), now).recent).toEqual(["worked", "renamed"]);
});

test("a snoozed thread rests in Recent, below finished ones, until its time passes", () => {
  const entries = [
    entry("asks", { state: "needs_you", interactions: 1 }, now, { snoozedUntil: now + hour }),
    entry("done", { state: "done" }, now),
  ];
  expect(arrange(entries, state(), now)).toMatchObject({ active: [], recent: ["done", "asks"] });
  expect(arrange(entries, state(), now + 2 * hour)).toMatchObject({
    active: ["asks"],
    recent: ["done"],
  });
});

test("threads the daemon settled go to Settled, except one that needs you again", () => {
  const entries = [
    entry("settled", { state: "done" }, now - 2 * hour, { settledAt: now - hour }),
    entry("fresh", { state: "done" }, now - hour),
    entry("asks", { state: "needs_you", interactions: 1 }, now, { settledAt: now - hour }),
  ];
  const result = arrange(entries, state(), now);
  expect(result.settled).toEqual(["settled"]);
  expect(result.active).toEqual(["asks"]);
  expect(result.recent).toEqual(["fresh"]);
});

test("archived and deleted threads leave Home and its project counts", () => {
  const entries = [
    entry("kept", { state: "done" }, now, { workspaceId: "web" }),
    entry("archived", { state: "done" }, now, { archivedAt: now }),
    entry("deleted", { state: "done" }, now, { deletedAt: now }),
  ];
  expect(arrange(entries, state(), now).recent).toEqual(["kept"]);
  expect(projectCounts(entries)).toEqual([{ id: "web", threads: 1 }]);
});

test("the project filter keeps only that project's threads", () => {
  const entries = [
    entry("a", { state: "done" }, now, { workspaceId: "ace" }),
    entry("w", { state: "done" }, now, { workspaceId: "web" }),
  ];
  expect(arrange(entries, state({ project: "web" }), now).recent).toEqual(["w"]);
});

test("finished work is unread until read on any device, and a hand-set mark always is", () => {
  const done = (extra: Parameters<typeof entry>[3]) =>
    entry("t", { state: "done" }, now, { activityAt: now - hour, ...extra });
  expect(isUnread(done({}), 0)).toBe(true);
  expect(isUnread(done({}), now)).toBe(false);
  expect(isUnread(done({ readAt: now - 2 * hour }), now)).toBe(true);
  expect(isUnread(done({ readAt: now, unread: false }), 0)).toBe(false);
  expect(isUnread(done({ readAt: now, unread: true }), 0)).toBe(true);
  expect(isUnread(entry("w", { state: "working", agents: 1 }, now), 0)).toBe(false);
});

test("the home machine is where most threads run", () => {
  const on = (id: string, host: string) =>
    entry(id, { state: "done" }, now, { details: { machine: { host, name: host } } });
  expect(homeMachine([on("a", "laptop"), on("b", "build-box"), on("c", "laptop")])).toBe("laptop");
  expect(homeMachine([entry("x", { state: "done" }, now)])).toBeUndefined();
});

test("an untouched New thread draft stays out of the task list, while named new tasks remain", () => {
  const draft = entry("draft", { state: "new" }, now, { title: "New thread" });
  const task = entry("sent", { state: "working", agents: 1 }, now, { title: "New thread" });
  const named = entry("named", { state: "new" }, now, { title: "Plan rollout" });
  const renamedDraft = entry("renamed", { state: "new" }, now, {
    title: "Renamed draft",
    hasSentMessage: false,
  });
  const sentNew = entry("admitted", { state: "new" }, now, {
    title: "New thread",
    hasSentMessage: true,
  });
  const list = arrange([draft, renamedDraft, task, named, sentNew], state(), now);
  expect([...list.pinned, ...list.active, ...list.recent, ...list.settled]).toEqual([
    "sent",
    "named",
    "admitted",
  ]);
  expect(projectCounts([draft, renamedDraft])).toEqual([]);
});
