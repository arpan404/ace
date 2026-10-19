import { expect, test } from "vitest";
import { isDeepReasoning, reasoningDescription, showsAceMark } from "./reasoning-level.ts";

test.each(["ultra", "ultrathink", "max"])(
  "only an explicitly supported %s level gets the deep accent",
  (level) => {
    expect(isDeepReasoning(level, ["low", "high", level])).toBe(true);
    expect(isDeepReasoning(level, ["low", "high"])).toBe(false);
  },
);
test("High and Extra high never become Ultra just because they are the final capability", () => {
  expect(isDeepReasoning("high", ["low", "medium", "high"])).toBe(false);
  expect(isDeepReasoning("xhigh", ["low", "high", "xhigh"])).toBe(false);
  expect(isDeepReasoning(undefined, ["high", "max"])).toBe(false);
});

test("unreported reasoning stays unknown until explicitly selected", () => {
  expect(reasoningDescription(undefined)).toContain("No reasoning level has been reported");
});

test("the ace mark is kept for Ultra and ultrathink; Max glows without it", () => {
  expect(showsAceMark("ultra", ["high", "ultra"])).toBe(true);
  expect(showsAceMark("ultrathink", ["high", "ultrathink"])).toBe(true);
  expect(showsAceMark("max", ["high", "max"])).toBe(false);
  expect(isDeepReasoning("max", ["high", "max"])).toBe(true);
  // Named but not offered by this model: no mark.
  expect(showsAceMark("ultra", ["high", "max"])).toBe(false);
});
