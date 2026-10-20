import { expect, test } from "vitest";
import { LiveFrames, nextNear } from "./live-frames.ts";

test("only the most recently revealed visualizations keep a live page, and a hidden one unloads", () => {
  const frames = new LiveFrames(2);
  let changes = 0;
  frames.subscribe(() => changes++);
  frames.near("a", true);
  frames.near("b", true);
  expect([frames.live("a"), frames.live("b")]).toEqual([true, true]);

  // A third frame scrolls into view: the one revealed longest ago unloads.
  frames.near("c", true);
  expect([frames.live("a"), frames.live("b"), frames.live("c")]).toEqual([false, true, true]);

  // Scrolling away from "c" brings "a" back within the limit.
  frames.near("c", false);
  expect([frames.live("a"), frames.live("b"), frames.live("c")]).toEqual([true, true, false]);
  expect(changes).toBe(4);

  // A frame that was never near does not notify anyone when it reports it is still away.
  frames.near("d", false);
  expect(changes).toBe(4);
  expect(frames.live("d")).toBe(false);
});

test("a visualization loads before it scrolls into view and stays loaded until it is well out of view", () => {
  expect(nextNear(false, true, true)).toBe(true);
  expect(nextNear(true, false, true)).toBe(true);
  expect(nextNear(true, false, false)).toBe(false);
  expect(nextNear(false, false, true)).toBe(false);
});
