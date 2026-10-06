import { expect, test } from "vitest";
import { arrange } from "./arrange.ts";
import { patchedEntry, patchEntry, reflects } from "./organize-patch.ts";
import { entry } from "./test-entries.fixture.ts";
import { isSettled, isSnoozed, isUnread } from "./thread-state.ts";

const now = 1_000_000;
const done = (extra: Record<string, unknown> = {}) =>
  entry("t", { state: "done" }, now - 60_000, { activityAt: now - 60_000, ...extra });
const view = { project: null };

test("settling puts a finished thread in Settled and drops its snooze", () => {
  const settled = patchEntry(done({ snoozedUntil: now + 3_600_000 }), { settled: true }, now);
  expect(isSettled(settled)).toBe(true);
  expect(isSnoozed(settled, now)).toBe(false);
  expect(arrange([settled], view, now)).toEqual({ pinned: [], active: [], settled: ["t"] });
});

test("unsettling brings it back to the list as the newest activity", () => {
  const older = entry("old", { state: "done" }, now - 5_000, { activityAt: now - 5_000 });
  const back = patchEntry(
    done({ settledAt: now - 1, settledReason: "manual" }),
    { settled: false },
    now,
  );
  expect(arrange([older, back], view, now).active).toEqual(["t", "old"]);
});

test("snoozing sinks a thread until its wake time, and null wakes it", () => {
  const snoozed = patchEntry(done(), { snoozedUntil: now + 60_000 }, now);
  expect(isSnoozed(snoozed, now)).toBe(true);
  expect(isSnoozed(patchEntry(snoozed, { snoozedUntil: null }, now), now)).toBe(false);
});

test("marking read reads up to the thread's latest activity even with a slow clock here", () => {
  const unread = done({ unread: true });
  expect(isUnread(patchEntry(unread, { unread: false }, now - 120_000), 0)).toBe(false);
  expect(isUnread(patchEntry(done({ readAt: now }), { unread: true }, now), 0)).toBe(true);
});

test("archive and delete take a thread off Home; unarchive brings it back", () => {
  const archived = patchEntry(done(), { archived: true }, now);
  expect(arrange([archived], view, now).active).toEqual([]);
  expect(arrange([patchEntry(archived, { archived: false }, now)], view, now).active).toEqual([
    "t",
  ]);
  expect(arrange([patchEntry(done(), { deleted: true }, now)], view, now).active).toEqual([]);
});

test("pending actions apply oldest first, so an Undo wins over what it undoes", () => {
  const shown = patchedEntry(done(), [
    { patch: { title: "Renamed" }, at: now },
    { patch: { pinned: true }, at: now },
    { patch: { title: "Thread t" }, at: now },
  ]);
  expect(shown).toMatchObject({ title: "Thread t", pinned: true });
});

test("the daemon's entry shows an action once its fields say so", () => {
  const before = done();
  expect(reflects(before, { title: "New" }, before)).toBe(false);
  expect(reflects({ ...before, title: "New" }, { title: "New" }, before)).toBe(true);
  expect(reflects({ ...before, settledAt: now }, { settled: true }, before)).toBe(true);
  expect(reflects(before, { snoozedUntil: null }, before)).toBe(true);
  expect(reflects({ ...before, archivedAt: now }, { archived: true }, before)).toBe(true);
  // A thread the daemon deleted leaves the list: that shows the delete.
  expect(reflects(undefined, { deleted: true }, before)).toBe(true);
});

test("marking read shows only once the daemon records a new read time", () => {
  const before = done({ readAt: now - 120_000 });
  // Not flagged unread, but its activity is newer than the last read: nothing new arrived yet.
  expect(reflects(before, { unread: false }, before)).toBe(false);
  expect(reflects({ ...before, unread: false, readAt: now }, { unread: false }, before)).toBe(true);
});

test("a pin shows in its place at once: dragged ones where dropped, others at the top", () => {
  const top = patchEntry(done(), { pinned: true }, now);
  expect(top).toMatchObject({ pinned: true, pinOrder: now });
  const dropped = patchEntry(top, { pinned: true, pinOrder: 12.5 }, now + 1);
  expect(dropped.pinOrder).toBe(12.5);
  // Pinning again from a menu keeps the dragged place, as the daemon does.
  expect(patchEntry(dropped, { pinned: true }, now + 2).pinOrder).toBe(12.5);
  const unpinned = patchEntry(dropped, { pinned: false }, now + 3);
  expect(unpinned.pinned).toBe(false);
  expect(unpinned.pinOrder).toBeUndefined();
});

test("a move among pinned threads shows until the daemon's entry has the new place", () => {
  const before = { ...done(), pinned: true, pinOrder: 4 };
  expect(reflects(before, { pinned: true, pinOrder: 7 }, before)).toBe(false);
  expect(reflects({ ...before, pinOrder: 7 }, { pinned: true, pinOrder: 7 }, before)).toBe(true);
});
