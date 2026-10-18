import { expect, test } from "vitest";
import {
  flingSpeed,
  restingHighlight,
  sampleScroll,
  settleAt,
  settleMs,
  type RailHighlight,
} from "./rail-highlight.ts";

/** Scrolls at `speed` px/ms in 16 ms frames from `from` for `frames` frames. */
function scroll(
  state: RailHighlight,
  speed: number,
  frames: number,
  from = { position: 0, time: 0 },
): { state: RailHighlight; position: number; time: number } {
  let { position, time } = from;
  let next = state.time === undefined ? sampleScroll(state, position, time) : state;
  for (let frame = 0; frame < frames; frame++) {
    position += speed * 16;
    time += 16;
    next = sampleScroll(next, position, time);
  }
  return { state: next, position, time };
}

test("a resting transcript shows the reader's turn", () => {
  expect(restingHighlight.shown).toBe(true);
  expect(sampleScroll(restingHighlight, 0, 0).shown).toBe(true);
});

test("a fast scroll hides the mark", () => {
  const fling = scroll(restingHighlight, flingSpeed * 2, 3);
  expect(fling.state.shown).toBe(false);
});

test("a slow scroll never hides the mark", () => {
  const reading = scroll(restingHighlight, flingSpeed / 2, 30);
  expect(reading.state.shown).toBe(true);
});

test("a fast scroll upward hides the mark too", () => {
  const fling = scroll(restingHighlight, -flingSpeed * 2, 3, { position: 5000, time: 0 });
  expect(fling.state.shown).toBe(false);
});

test("the mark returns once the scroll stays below fling speed for the settle window", () => {
  const fling = scroll(restingHighlight, flingSpeed * 3, 5);
  const brief = scroll(fling.state, flingSpeed / 3, 3, fling);
  expect(brief.state.shown).toBe(false);
  const slowFrames = Math.ceil(settleMs / 16);
  const calm = scroll(fling.state, flingSpeed / 3, slowFrames, fling);
  expect(calm.state.shown).toBe(true);
});

test("speeding up again during the settle window restarts it", () => {
  const fling = scroll(restingHighlight, flingSpeed * 3, 5);
  const slowing = scroll(fling.state, flingSpeed / 3, Math.ceil(settleMs / 16) - 2, fling);
  const again = scroll(slowing.state, flingSpeed * 3, 1, slowing);
  const calm = scroll(again.state, flingSpeed / 3, 3, again);
  expect(calm.state.shown).toBe(false);
});

test("a scroll that stops shows the mark once the settle window passes without samples", () => {
  const fling = scroll(restingHighlight, flingSpeed * 3, 5);
  expect(settleAt(fling.state, fling.time + settleMs - 1).shown).toBe(false);
  expect(settleAt(fling.state, fling.time + settleMs).shown).toBe(true);
});

test("samples landing in the same instant do not count as an infinitely fast scroll", () => {
  const start = sampleScroll(restingHighlight, 0, 100);
  expect(sampleScroll(start, 400, 100).shown).toBe(true);
});
