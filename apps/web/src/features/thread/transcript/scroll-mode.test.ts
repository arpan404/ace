import { expect, test } from "vitest";
import {
  compensation,
  correction,
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
const scrolled = (atEnd: boolean): ScrollEvent => ({
  type: "scrolled",
  atEnd,
  upward: false,
  detached: false,
  gliding: false,
});

test("the reader's gesture cancels a jump still re-aiming at its row", () => {
  const after = run(following, jump, wheel(false));
  expect(after.cancelled).toBe(true);
  expect(after.mode.kind).toBe("free");
  // Rows still arriving after the gesture leave the view where the reader took it.
  const held = { key: "turn-3", itemId: "ask-3", start: 400 };
  expect(correction(after.mode, held, { index: 9, start: 400 }, 200)).toEqual({ kind: "none" });
});

test("a press on the view stops a landing jump's aim but keeps its row held", () => {
  const after = run(following, jump, { type: "press", at: 50 });
  expect(after.cancelled).toBe(true);
  expect(after.mode).toMatchObject({ kind: "anchoring", key: "turn-3", aimUntil: 0 });
});

test("a jump still landing aims again at its row's new index when rows arrive above it", () => {
  const { mode } = run(following, jump);
  const held = { key: "turn-3", itemId: "ask-3", start: 400 };
  expect(correction(mode, held, { index: 14, start: 1200 }, 1_000)).toEqual({
    kind: "aim",
    index: 14,
    align: "start",
  });
  // Once it has landed, it holds its row by how far that row moved.
  expect(correction(mode, held, { index: 14, start: 1200 }, 10_000)).toEqual({
    kind: "shift",
    by: 800,
  });
});

test("opening a disclosure while following holds its row instead of scrolling past it", () => {
  const toggled = run(following, { type: "toggle", key: "work:ask", itemId: "grep" });
  expect(toggled.mode).toMatchObject({ kind: "anchoring", key: "work:ask" });
  const held = { key: "work:ask", itemId: "grep", start: 900 };
  // The group grew below its header: nothing above it moved, so neither does the view.
  expect(correction(toggled.mode, held, { index: 4, start: 900 }, 0)).toEqual({ kind: "none" });
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
  // The first row in view was the turn's log at 2,000; three older rows arrived above it.
  const held = { key: "work:turn-40", itemId: "step-12", start: 2_000 };
  expect(correction(mode, held, { index: 3, start: 2_288 }, 0)).toEqual({ kind: "shift", by: 288 });
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
  const held = { key: "message:answer-7", itemId: "answer-7", start: 2_000 };
  // Older history paged in above: the held row moved down by the new rows' height.
  expect(correction(mode, held, { index: 30, start: 5_200 }, 0)).toEqual({
    kind: "shift",
    by: 3_200,
  });
  // A row above was replaced at the same index by a shorter one: the held row's index is the
  // same, but it moved, and the view moves with it.
  expect(correction(mode, held, { index: 12, start: 1_940 }, 0)).toEqual({
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
    }).mode.kind,
  ).toBe("free");
  expect(transition(following, { type: "detached" }).mode.kind).toBe("free");
});
