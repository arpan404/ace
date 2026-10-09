import { expect, test } from "vitest";
import { isDeepReasoning, reasoningDescription } from "./reasoning-level.ts";

test.each(["ultra", "xhigh", "extra_high", "max"])(
  "only an explicitly supported %s level gets the deep accent",
  (level) => {
    expect(isDeepReasoning(level, ["low", "high", level])).toBe(true);
    expect(isDeepReasoning(level, ["low", "high"])).toBe(false);
  },
);
test("High never becomes Ultra just because it is the final capability", () => {
  expect(isDeepReasoning("high", ["low", "medium", "high"])).toBe(false);
  expect(isDeepReasoning(undefined, ["high", "max"])).toBe(false);
});

test("unreported reasoning stays unknown until explicitly selected", () => {
  expect(reasoningDescription(undefined)).toContain("No reasoning level has been reported");
});
