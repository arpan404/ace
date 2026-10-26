import { expect, test } from "vitest";
import {
  compensation,
  correction,
  handOver,
  heldKey,
  heldSuccessor,
  joinedAtTop,
  transition,
  type ScrollEvent,
  type ScrollMode,
} from "./scroll-mode.ts";

const following: ScrollMode = { kind: "following" };
const run = (mode: ScrollMode, ...events: ScrollEvent[]) => {
  let cancelled = false;
  for (const event of events) {
    const step = transition(mode, event);
    mode = step.mode;
    cancelled ||= step.cancelAim;
  }
  return { mode, cancelled };
};
const jump: ScrollEvent = { type: "jump", key: "turn-3", itemId: "ask-3", align: "start", at: 0 };
const wheel = (upward: boolean, at = 100, atEnd = false): ScrollEvent => ({
  type: "gesture",
  upward,
  atEnd,
  detached: false,
  at,
});
const scrolled = (atEnd: boolean, upward = false, at = 150): ScrollEvent => ({
  type: "scrolled",
  atEnd,
  upward,
  detached: false,
  gliding: false,
  at,
});

test("the reader's gesture cancels a jump still re-aiming at its row", () => {
  const after = run(following, jump, wheel(false));
  expect(after.cancelled).toBe(true);
  expect(after.mode.kind).toBe("free");
  // Rows still arriving after the gesture leave the view where the reader took it.
  const held = { key: "turn-3", itemId: "ask-3", top: 400 };
  expect(correction(after.mode, held, { index: 9, top: 400 }, 200)).toEqual({ kind: "none" });
});

test("a press on the view stops a landing jump's aim but keeps its row held", () => {
  const after = run(following, jump, { type: "press", at: 50 });
  expect(after.cancelled).toBe(true);
  expect(after.mode).toMatchObject({ kind: "anchoring", key: "turn-3", aimUntil: 0 });
});

test("a jump still landing aims again at its row's new index when rows arrive above it", () => {
  const { mode } = run(following, jump);
  const held = { key: "turn-3", itemId: "ask-3", top: 400 };
  expect(correction(mode, held, { index: 14, top: 1200 }, 1_000)).toEqual({
    kind: "aim",
    index: 14,
    align: "start",
  });
  // Once it has landed, it holds its row by how far that row moved.
  expect(correction(mode, held, { index: 14, top: 1200 }, 10_000)).toEqual({
    kind: "shift",
    by: 800,
  });
});

test("opening a disclosure while following holds its row instead of scrolling past it", () => {
  const toggled = run(following, { type: "toggle", key: "work:ask", itemId: "grep" });
  expect(toggled.mode).toMatchObject({ kind: "anchoring", key: "work:ask" });
  const held = { key: "work:ask", itemId: "grep", top: 900 };
  // The group grew below its header: nothing above it moved, so neither does the view.
  expect(correction(toggled.mode, held, { index: 4, top: 900 }, 0)).toEqual({ kind: "none" });
  // Code scrolling (a correction landing at the end) does not resume following ...
  expect(transition(toggled.mode, scrolled(true)).mode.kind).toBe("anchoring");
  // ... the reader returning to the end does.
  expect(run(toggled.mode, wheel(false, 0, true)).mode.kind).toBe("following");
});

test("rows above a held row move the view with them; rows below it do not", () => {
  const rule = compensation(
    { kind: "anchoring", key: "k", itemId: undefined, aimUntil: 0, align: "start" },
    { index: 9 },
  );
  expect(rule?.({ index: 3 })).toBe(true);
  expect(rule?.({ index: 9 })).toBe(false);
  expect(rule?.({ index: 14 })).toBe(false);
});

test("a reader inside a long answer keeps their place while it grows below them", () => {
  const { mode } = run(following, wheel(true));
  // The first row in view is the answer the reader is part way down; rows above it measure.
  const rule = compensation(mode, { index: 12 });
  expect(rule?.({ index: 11 })).toBe(true);
  // The answer itself streaming on grows below what the reader sees: nothing moves.
  expect(rule?.({ index: 12 })).toBe(false);
  expect(rule?.({ index: 13 })).toBe(false);
});

test("loading older turns keeps the reader's first visible row in place", () => {
  const { mode } = run(following, wheel(true));
  // The first row in view was the turn's log, 24px under the view's top; three older rows
  // arrived above it, pushing it 288px down the view.
  const held = { key: "work:turn-40", itemId: "step-12", top: 24 };
  expect(correction(mode, held, { index: 3, top: 312 }, 0)).toEqual({ kind: "shift", by: 288 });
  // As those rows measure, they move the view with them, and the held row does not.
  const rule = compensation(mode, { index: 3 });
  expect([0, 1, 2].every((index) => rule?.({ index }))).toBe(true);
  expect(rule?.({ index: 3 })).toBe(false);
  // When the page carried the turn's earlier steps, they joined the held row at its top: its
  // growth is then above the reader, and the view moves with it once.
  expect(joinedAtTop(["step-12", "step-13"], ["step-10", "step-11", "step-12", "step-13"])).toBe(
    true,
  );
  expect(joinedAtTop(["step-12", "step-13"], ["step-12", "step-13", "step-14"])).toBe(false);
  expect(compensation(mode, { index: 3, grewAtTop: true })?.({ index: 3 })).toBe(true);
});

test("a held row dropped as older history loads hands the reader's place to the row after it", () => {
  const { mode } = run(following, wheel(true));
  // The reader's first row in view was a delegate's result, 24px under the view's top. The older
  // page brought its launch row, which carries that result, so the result row left; the rows
  // after it now sit 900px lower, under the older page.
  const before = ["work:turn-9", "results-9", "message:answer-9", "files:turn-9"];
  const now = new Map([
    ["work:turn-9", { index: 40, top: 900 - 380 }],
    ["message:answer-9", { index: 41, top: 24 + 900 }],
    ["files:turn-9", { index: 42, top: 24 + 900 + 120 }],
  ]);
  const next = heldSuccessor(before, 1, (key) => now.get(key));
  expect(next).toEqual({ index: 41, top: 924 });
  // The answer that followed it takes its place where the reader saw the result.
  const held = { key: "results-9", itemId: "results-9", top: 24 };
  expect(correction(mode, held, next, 0)).toEqual({ kind: "shift", by: 900 });
  // With nothing shown after it, there is no place to keep.
  expect(heldSuccessor(["work:turn-9", "results-9"], 1, (key) => now.get(key))).toBeUndefined();
  // A jump to the gone row holds the row that took its place from then on, not the gone one.
  const jumped = run(following, { ...jump, key: "results-9", itemId: "results-9" }).mode;
  const after = handOver(jumped, { key: "message:answer-9", itemId: "answer-9" });
  expect(heldKey(after, { key: "work:turn-9", itemId: "step-1" })).toEqual({
    key: "message:answer-9",
    itemId: "answer-9",
  });
  // A free reader's mode names no row; it holds whatever is first in view.
  const free = run(following, wheel(true)).mode;
  expect(handOver(free, { key: "message:answer-9", itemId: "answer-9" })).toEqual(free);
});

test("older rows that already moved the view as they measured are not counted again", () => {
  const { mode } = run(following, wheel(true));
  // The reader sat at the very top, the first row 24px down. A page of older rows (2,016px by
  // their measured sizes) landed above it, and some of them measuring had already moved the view
  // 144px with them: only what is left of the drift is corrected.
  const held = { key: "message:answer-7", itemId: "answer-7", top: 24 };
  expect(correction(mode, held, { index: 42, top: 24 + 2_016 - 144 }, 0)).toEqual({
    kind: "shift",
    by: 1_872,
  });
});

test("the row the reader sees stays held while older rows settle above it", () => {
  const { mode } = run(following, wheel(true));
  const seen = { key: "message:answer-7", itemId: "answer-7" };
  // An older row not measured yet reaches into view by its estimated size.
  const above = { key: "work:turn-6", itemId: "step-3" };
  expect(heldKey(mode, above, seen)).toEqual(seen);
  // Once the reader moves the view again, the first row in view is held.
  expect(heldKey(mode, above, undefined)).toEqual(above);
  // A jump's row stays held either way.
  expect(heldKey(run(following, jump).mode, above, seen)).toMatchObject({ key: "turn-3" });
  // Following holds nothing.
  expect(heldKey(following, above, seen)).toBeUndefined();
});

test("even a small upward gesture releases live following before the scroll event", () => {
  const after = run(following, wheel(true, 100, true));
  expect(after.mode.kind).toBe("free");
  expect(transition(after.mode, scrolled(true, true)).mode.kind).toBe("free");
  expect(correction(after.mode, undefined, undefined, 5000)).toEqual({ kind: "none" });
});

test("growth without a reader gesture keeps following the live end", () => {
  const after = run(following, scrolled(false));
  expect(after.mode.kind).toBe("following");
  expect(correction(after.mode, undefined, undefined, 200)).toEqual({ kind: "end" });
});

test("following stays at the end through growth and resizes", () => {
  let mode: ScrollMode = following;
  for (const atEnd of [true, true]) mode = transition(mode, scrolled(atEnd)).mode;
  expect(mode.kind).toBe("following");
  expect(correction(mode, undefined, undefined, 0)).toEqual({ kind: "end" });
  expect(compensation(mode, undefined)?.({ index: 0 })).toBe(false);
  // An upward gesture releases it.
  expect(run(mode, wheel(true)).mode.kind).toBe("free");
});

test("free mode keeps the row in view steady when rows above it grow or are replaced", () => {
  const { mode } = run(following, wheel(true));
  const held = { key: "message:answer-7", itemId: "answer-7", top: 2_000 };
  // Older history paged in above: the held row moved down by the new rows' height.
  expect(correction(mode, held, { index: 30, top: 5_200 }, 0)).toEqual({
    kind: "shift",
    by: 3_200,
  });
  // A row above was replaced at the same index by a shorter one: the held row's index is the
  // same, but it moved, and the view moves with it.
  expect(correction(mode, held, { index: 12, top: 1_940 }, 0)).toEqual({
    kind: "shift",
    by: -60,
  });
  // A held row that left the window leaves the view as it is.
  expect(correction(mode, held, undefined, 0)).toEqual({ kind: "none" });
});

test("a free reader back at the end follows again; a detached window never follows", () => {
  const { mode } = run(following, wheel(true));
  expect(transition(mode, scrolled(true)).mode.kind).toBe("following");
  expect(
    transition(mode, {
      type: "scrolled",
      atEnd: true,
      upward: false,
      detached: true,
      gliding: false,
      at: 0,
    }).mode.kind,
  ).toBe("free");
  expect(transition(following, { type: "detached" }).mode.kind).toBe("free");
});
