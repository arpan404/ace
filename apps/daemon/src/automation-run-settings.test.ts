import { expect, test } from "vitest";
import type { PermissionState } from "@ace/protocol";
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

const state = (
  effective: PermissionState["effective"],
  override: PermissionState["override"] = effective,
  pending = false,
): PermissionState => ({ effective, override, pending });

test("a webhook run's thread may be no wider than its ceiling, now or once a change applies", () => {
  expect(withinCeiling(state("full-access"), undefined)).toBe(true);
  expect(withinCeiling(undefined, undefined)).toBe(true);
  expect(withinCeiling(state("read-only"), "read-only")).toBe(true);
  expect(withinCeiling(state("ask"), "auto-review")).toBe(true);
  expect(withinCeiling(state("auto-review"), "ask")).toBe(false);
  expect(withinCeiling(state("full-access"), "read-only")).toBe(false);
  // A widening asked for and still pending counts as the wider access.
  expect(withinCeiling(state("read-only", "full-access", true), "read-only")).toBe(false);
  // Following the defaults, a provider's own mode, or unknown: never within a ceiling.
  expect(withinCeiling(state("read-only", null), "full-access")).toBe(false);
  expect(withinCeiling({ ...state("read-only"), custom: "plan" }, "full-access")).toBe(false);
  expect(withinCeiling(state(null), "full-access")).toBe(false);
  expect(withinCeiling(undefined, "read-only")).toBe(false);
});
