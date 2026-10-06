import { expect, test } from "vitest";
import {
  dropTargetAt,
  indicatorAt,
  moveTargets,
  stepTarget,
  type DropTarget,
  type RowBox,
} from "./pin-drag.ts";

/** Pinned heading (0–30), pinned a, b, c (70 px each), then two other rows. */
const boxes: RowBox[] = [
  { kind: "pin-zone", top: 0, bottom: 30 },
  { kind: "pinned", id: "a", top: 30, bottom: 100 },
  { kind: "pinned", id: "b", top: 100, bottom: 170 },
  { kind: "pinned", id: "c", top: 170, bottom: 240 },
  { kind: "other", id: "x", top: 250, bottom: 320 },
  { kind: "other", id: "y", top: 320, bottom: 390 },
];
const none = new Set<string>();

test("over the Pinned group the target is the gap nearest the pointer", () => {
  expect(dropTargetAt(boxes, 10, new Set(["x"]))).toEqual({ kind: "pin", index: 0 });
  expect(dropTargetAt(boxes, 60, new Set(["x"]))).toEqual({ kind: "pin", index: 0 });
  expect(dropTargetAt(boxes, 70, new Set(["x"]))).toEqual({ kind: "pin", index: 1 });
  // Just past the last pinned row still drops at the bottom of the group.
  expect(dropTargetAt(boxes, 255, new Set(["x"]))).toEqual({ kind: "pin", index: 3 });
});

test("a moving pinned thread's own row isn't a place: indexes count the others", () => {
  const moving = new Set(["a"]);
  expect(dropTargetAt(boxes, 150, moving)).toEqual({ kind: "pin", index: 1 });
  expect(indicatorAt(boxes, { kind: "pin", index: 1 }, moving)).toBe(170);
});

test("below the group a pinned thread unpins and another thread has nowhere to go", () => {
  expect(dropTargetAt(boxes, 340, new Set(["b"]))).toEqual({ kind: "unpin" });
  expect(dropTargetAt(boxes, 340, new Set(["x"]))).toBeUndefined();
  expect(indicatorAt(boxes, { kind: "unpin" }, new Set(["b"]))).toBe(250);
});

test("with nothing pinned the heading's drop zone pins at the top", () => {
  const empty: RowBox[] = [
    { kind: "pin-zone", top: 0, bottom: 40 },
    { kind: "other", id: "x", top: 40, bottom: 110 },
  ];
  expect(dropTargetAt(empty, 20, new Set(["x"]))).toEqual({ kind: "pin", index: 0 });
  expect(indicatorAt(empty, { kind: "pin", index: 0 }, none)).toBe(40);
  expect(dropTargetAt(empty, 90, new Set(["x"]))).toBeUndefined();
});

test("arrow keys step through each pinned place, then out of the group, and stop at the ends", () => {
  const targets = moveTargets(2);
  let at: DropTarget = { kind: "unpin" };
  const seen: DropTarget[] = [];
  for (let step = 0; step < 4; step++) {
    at = stepTarget(targets, at, -1);
    seen.push(at);
  }
  expect(seen).toEqual([
    { kind: "pin", index: 2 },
    { kind: "pin", index: 1 },
    { kind: "pin", index: 0 },
    { kind: "pin", index: 0 },
  ]);
  expect(stepTarget(targets, { kind: "pin", index: 2 }, 1)).toEqual({ kind: "unpin" });
  expect(stepTarget(targets, { kind: "unpin" }, 1)).toEqual({ kind: "unpin" });
});
