import { activityReadLimits, type ActivityReadCursor } from "@ace/protocol";
import { applyActivityReads, isActivityRead } from "@ace/projection/activity-reads";
import { expect, test } from "vitest";
import { compactChanges, type Change } from "./read-state.ts";

const cursor: ActivityReadCursor = { before: 100, read: [], unread: [], revision: 0 };
const item = (id: string, at: number) => ({ id, at });

test("marks waiting to be sent fold into one change that means the same thing", () => {
  const steps: Change[] = [
    { read: [item("a", 200)] },
    { unread: [item("old", 50)] },
    { allBefore: 300 },
    { unread: [item("a", 200)] },
  ];
  const oneByOne = steps.reduce((current, step) => applyActivityReads(current, step), cursor);
  const folded = applyActivityReads(
    cursor,
    steps.reduce((first, later) => compactChanges(first, later), {}),
  );
  for (const ref of [item("a", 200), item("old", 50), item("new", 400)])
    expect(isActivityRead(folded, ref)).toBe(isActivityRead(oneByOne, ref));
});

test("however many marks wait, the change sent stays within what the protocol accepts", () => {
  let waiting: Change = {};
  for (let at = 0; at < 3_000; at++)
    waiting = compactChanges(waiting, { read: [item(`r${at}`, at)] });
  const read = waiting.read ?? [];
  expect(read.length).toBe(activityReadLimits.change);
  // The newest marks are the ones kept.
  expect(read[0]).toEqual(item("r2999", 2999));
});
