import { expect, test } from "vitest";
import { withinCeiling, runSettings } from "./automation-executor.ts";

const first = { model: "opus", effort: "high" };

test("a run leaves the thread's model and effort alone while the automation's are unchanged", () => {
  // What the thread was created with, as the executor records it.
  const applied = JSON.stringify({ model: "opus", effort: "high" });
  expect(runSettings(first, applied)).toEqual({});
});

test("a run carries the automation's model and effort once they change", () => {
  const applied = JSON.stringify({ model: "opus", effort: "high" });
  expect(runSettings({ model: "sonnet", effort: "low" }, applied)).toEqual({
    model: "sonnet",
    options: { effort: "low" },
  });
  expect(runSettings({ model: "opus" }, applied)).toEqual({ model: "opus" });
});

test("a thread with nothing recorded gets the automation's settings", () => {
  expect(runSettings(first, undefined)).toEqual({ model: "opus", options: { effort: "high" } });
});

test("a webhook run's thread may be no wider than its ceiling, and an unknown access never is", () => {
  expect(withinCeiling("full-access", undefined)).toBe(true);
  expect(withinCeiling("read-only", "read-only")).toBe(true);
  expect(withinCeiling("ask", "auto-review")).toBe(true);
  expect(withinCeiling("auto-review", "ask")).toBe(false);
  expect(withinCeiling("full-access", "read-only")).toBe(false);
  expect(withinCeiling(null, "full-access")).toBe(false);
  expect(withinCeiling(undefined, "read-only")).toBe(false);
});
