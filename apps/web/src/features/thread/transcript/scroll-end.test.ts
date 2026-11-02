import { expect, test } from "vitest";
import {
  atEnd,
  canLeaveEnd,
  distanceToEnd,
  followsDockChange,
  showsScrollToEnd,
  type Extent,
} from "./scroll-end.ts";
import { transition, type ScrollEvent, type ScrollMode } from "./scroll-mode.ts";

const following: ScrollMode = { kind: "following" };

/** A reader's gesture on `view`, as the scroller's shell reports it. */
const gesture = (view: Extent, upward: boolean): ScrollEvent => ({
  type: "gesture",
  upward,
  atEnd: atEnd(view),
  scrollable: canLeaveEnd(view),
  detached: false,
  at: 0,
});
/** The scroll event after the reader's gesture moved `view`. */
const scrolled = (view: Extent, upward: boolean): ScrollEvent => ({
  type: "scrolled",
  atEnd: atEnd(view),
  upward,
  detached: false,
  gliding: false,
  at: 0,
});

const viewHeight = 800;
const long = (scrollTop: number, scrollHeight = 6_000): Extent => ({
  scrollTop,
  scrollHeight,
  clientHeight: viewHeight,
});
const bottomOf = (view: Extent) => view.scrollHeight - view.clientHeight;

test("a wheel nudge on a transcript that doesn't overflow never shows Scroll to end", () => {
  // One ask, a short reply and a question card: shorter than the view, no scrollbar.
  const short: Extent = { scrollTop: 0, scrollHeight: 640, clientHeight: viewHeight };
  let mode = following;
  for (const upward of [true, true, false, true]) {
    mode = transition(mode, gesture(short, upward)).mode;
    expect(showsScrollToEnd(mode, short)).toBe(false);
  }
  // It keeps following, so a reply that grows past the view stays pinned to its end.
  expect(mode.kind).toBe("following");
});

test("an overflow smaller than the near-end margin is not something to scroll away from", () => {
  const barely: Extent = { scrollTop: 30, scrollHeight: viewHeight + 30, clientHeight: viewHeight };
  const mode = transition(following, gesture(barely, true)).mode;
  expect(mode.kind).toBe("following");
  expect(showsScrollToEnd(mode, { ...barely, scrollTop: 0 })).toBe(false);
});

test("a reader 500px up a long transcript sees Scroll to end", () => {
  const end = long(bottomOf(long(0)));
  let mode = transition(following, gesture(end, true)).mode;
  const up = long(end.scrollTop - 500);
  mode = transition(mode, scrolled(up, true)).mode;
  expect(mode.kind).not.toBe("following");
  expect(distanceToEnd(up)).toBe(500);
  expect(showsScrollToEnd(mode, up)).toBe(true);
});

test("scrolling back to within the margin hides Scroll to end and follows again", () => {
  const end = bottomOf(long(0));
  let mode = transition(following, gesture(long(end), true)).mode;
  mode = transition(mode, scrolled(long(end - 500), true)).mode;
  expect(showsScrollToEnd(mode, long(end - 500))).toBe(true);

  const back = long(end - 30);
  mode = transition(mode, gesture(long(end - 500), false)).mode;
  mode = transition(mode, scrolled(back, false)).mode;
  expect(mode.kind).toBe("following");
  expect(showsScrollToEnd(mode, back)).toBe(false);
});

test("a small nudge up a long streaming transcript holds still, with the pill once the end moves on", () => {
  const end = bottomOf(long(0));
  let mode = transition(following, gesture(long(end), true)).mode;
  const nudged = long(end - 12);
  mode = transition(mode, scrolled(nudged, true)).mode;
  // The reader stopped following but is still within reach of the end: no pill yet.
  expect(mode.kind).toBe("free");
  expect(showsScrollToEnd(mode, nudged)).toBe(false);
  // Streamed lines push the end 300px further away while the view stays put.
  expect(showsScrollToEnd(mode, long(nudged.scrollTop, 6_300))).toBe(true);
});

test("a docked card changing height while at the end keeps following, without the pill", () => {
  // Following: the card's growth moves the end, and the view goes with it.
  expect(showsScrollToEnd(following, long(bottomOf(long(0)) - 220, 6_220))).toBe(false);

  // A reader who nudged a few pixels off following, still at the end, is kept there too.
  const end = bottomOf(long(0));
  let mode = transition(following, gesture(long(end), true)).mode;
  mode = transition(mode, scrolled(long(end - 10), true)).mode;
  expect(followsDockChange(mode, distanceToEnd(long(end - 10)), false)).toBe(true);
});

test("a docked card changing height leaves a reader up in the history where they are", () => {
  const end = bottomOf(long(0));
  let mode = transition(following, gesture(long(end), true)).mode;
  mode = transition(mode, scrolled(long(end - 500), true)).mode;
  expect(followsDockChange(mode, 500, false)).toBe(false);
  // A history window or a jump's row never follows on its own.
  expect(followsDockChange(mode, 0, true)).toBe(false);
  const jumped: ScrollMode = {
    kind: "anchoring",
    key: "turn-3",
    itemId: undefined,
    aimUntil: 0,
    align: "start",
  };
  expect(followsDockChange(jumped, 0, false)).toBe(false);
});
