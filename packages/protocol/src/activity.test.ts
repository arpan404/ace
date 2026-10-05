import { expect, test } from "vitest";
import { applyActivityReads, isActivityRead, type ActivityReadCursor } from "./activity.ts";

const start: ActivityReadCursor = { before: 100, read: [], unread: [], revision: 0 };
const old = { id: "old", at: 50 };
const recent = { id: "recent", at: 200 };

test("items from before the cursor are read until marked unread, newer ones until marked read", () => {
  expect(isActivityRead(start, old)).toBe(true);
  expect(isActivityRead(start, recent)).toBe(false);
  const marked = applyActivityReads(start, { read: [recent], unread: [old] });
  expect(isActivityRead(marked, old)).toBe(false);
  expect(isActivityRead(marked, recent)).toBe(true);
  expect(marked.revision).toBe(1);
});

test("two devices' marks merge rather than replace each other", () => {
  const laptop = applyActivityReads(start, { read: [recent] });
  const both = applyActivityReads(laptop, { read: [{ id: "other", at: 300 }] });
  expect(isActivityRead(both, recent)).toBe(true);
  expect(isActivityRead(both, { id: "other", at: 300 })).toBe(true);
});

test("Mark all read covers everything up to its instant and drops the marks it covers", () => {
  const marked = applyActivityReads(start, { read: [recent], unread: [old] });
  const all = applyActivityReads(marked, { allBefore: 250 });
  expect(all).toMatchObject({ before: 250, read: [], unread: [] });
  expect(isActivityRead(all, old)).toBe(true);
  expect(isActivityRead(all, { id: "later", at: 260 })).toBe(false);
  // The cursor never moves back.
  expect(applyActivityReads(all, { allBefore: 10 }).before).toBe(250);
});
