import { expect, test } from "vitest";
import { arrange, homeMachine, isUnread, projectCounts } from "./arrange.ts";
import type { OrganizerState } from "./organizer.ts";
import { entry } from "./test-entries.fixture.ts";

const hour = 3_600_000;
const now = 10 * 24 * hour;
const state = (patch: Partial<OrganizerState> = {}): OrganizerState => ({
  baseline: 0,
  project: null,
  settledOpen: false,
  hiding: new Set(),
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

test("within a group the daemon's pinned threads lead, then the most recently active", () => {
  const entries = [
    entry("older", { state: "working", agents: 1 }, now - 3 * hour),
    entry("newer", { state: "working", agents: 1 }, now - hour),
    entry("pinned", { state: "working", agents: 1 }, now - 5 * hour, { pinned: true }),
  ];
  expect(arrange(entries, state(), now).active).toEqual(["pinned", "newer", "older"]);
});

test("recency is the last work, so renaming or pinning a thread doesn't move it up", () => {
  const entries = [
    entry("worked", { state: "done" }, now - 2 * hour, { activityAt: now - 2 * hour }),
    entry("renamed", { state: "done" }, now, { activityAt: now - 5 * hour }),
  ];
  expect(arrange(entries, state(), now).active).toEqual(["worked", "renamed"]);
});

test("a snoozed thread sinks below everything until its time passes", () => {
  const entries = [
    entry("asks", { state: "needs_you", interactions: 1 }, now, { snoozedUntil: now + hour }),
    entry("done", { state: "done" }, now),
  ];
  expect(arrange(entries, state(), now).active).toEqual(["done", "asks"]);
  expect(arrange(entries, state(), now + 2 * hour).active).toEqual(["asks", "done"]);
});

test("threads the daemon settled go to Settled, except one that needs you again", () => {
  const entries = [
    entry("settled", { state: "done" }, now - 2 * hour, { settledAt: now - hour }),
    entry("fresh", { state: "done" }, now - hour),
    entry("asks", { state: "needs_you", interactions: 1 }, now, { settledAt: now - hour }),
  ];
  const result = arrange(entries, state(), now);
  expect(result.settled).toEqual(["settled"]);
  expect(result.active).toEqual(["asks", "fresh"]);
});

test("archived, deleted and hiding threads leave Home and its project counts", () => {
  const entries = [
    entry("kept", { state: "done" }, now, { workspaceId: "web" }),
    entry("archived", { state: "done" }, now, { archivedAt: now }),
    entry("deleted", { state: "done" }, now, { deletedAt: now }),
    entry("hiding", { state: "done" }, now),
  ];
  const organised = state({ hiding: new Set(["hiding"]) });
  expect(arrange(entries, organised, now).active).toEqual(["kept"]);
  expect(projectCounts(entries, organised)).toEqual([{ id: "web", threads: 1 }]);
});

test("the project filter keeps only that project's threads", () => {
  const entries = [
    entry("a", { state: "done" }, now, { workspaceId: "ace" }),
    entry("w", { state: "done" }, now, { workspaceId: "web" }),
  ];
  expect(arrange(entries, state({ project: "web" }), now).active).toEqual(["w"]);
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
