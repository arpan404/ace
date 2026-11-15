import { expect, it } from "vitest";
import { keepsTimer } from "./actor.ts";

const armed = { at: 5000, armedAt: 1000 };
it.each([
  ["the same deadline, still ahead, shortly after arming", armed, 5000, 1500, true],
  ["nothing armed", undefined, 5000, 1500, false],
  ["a moved deadline", armed, 4000, 1500, false],
  ["a deadline already due", armed, 5000, 5000, false],
  ["a clock that stepped back since arming", armed, 5000, 900, false],
  ["a timer armed a second or more ago", armed, 5000, 2000, false],
] as const)("keeps the armed timer for %s: %s", (_name, timer, at, now, kept) => {
  expect(keepsTimer(timer, at, now)).toBe(kept);
});
