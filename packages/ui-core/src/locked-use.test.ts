import { expect, test } from "vitest";
import {
  lockedUseLabel,
  lockedUseRefusal,
  lockedUseShown,
  lockedUseSwitchOn,
  lockedUseUnavailable,
} from "./locked-use.ts";

test("each Mac state reads as the word the row shows, with a matching tone", () => {
  expect(lockedUseLabel({ state: "on" })).toEqual({ label: "On", tone: "done" });
  expect(lockedUseLabel({ state: "off" })).toEqual({ label: "Off", tone: "idle" });
  expect(lockedUseLabel({ state: "needsApproval" }).label).toBe("Needs approval");
  expect(lockedUseLabel({ state: "installing" }).label).toBe("Needs approval");
  expect(lockedUseLabel({ state: "installFailed", reason: "x" })).toEqual({
    label: "Install failed",
    tone: "failed",
  });
  expect(lockedUseLabel({ state: "driftRepairNeeded", reason: "moved" }).tone).toBe("failed");
});

test("an install that can never succeed reads as coming soon, not a failure", () => {
  for (const reason of [
    "Privileged install pending owner review.",
    "This feature will ship in a later build.",
  ]) {
    const status = { state: "installFailed", reason, unavailable: true } as const;
    expect(lockedUseUnavailable(status)).toBe(true);
    expect(lockedUseLabel(status)).toEqual({ label: "Coming soon", tone: "idle" });
    expect(lockedUseSwitchOn(status)).toBe(false);
  }
  const denied = { state: "installFailed", reason: "The administrator declined." } as const;
  expect(lockedUseUnavailable(denied)).toBe(false);
  expect(lockedUseLabel(denied).label).toBe("Install failed");
});

test("the switch reads on only while the component is installed or on its way", () => {
  expect(lockedUseSwitchOn({ state: "on" })).toBe(true);
  expect(lockedUseSwitchOn({ state: "needsApproval" })).toBe(true);
  expect(lockedUseSwitchOn({ state: "driftRepairNeeded", reason: "moved" })).toBe(true);
  expect(lockedUseSwitchOn({ state: "off" })).toBe(false);
  expect(lockedUseSwitchOn({ state: "installFailed", reason: "denied" })).toBe(false);
});

test("a refusal code becomes a sentence, and an unknown one falls back to the daemon's reason", () => {
  expect(lockedUseRefusal("forbidden", undefined)).toBe("Only this Mac's owner can change this.");
  expect(lockedUseRefusal("busy", "Another change is running.")).toMatch(/still running/);
  expect(lockedUseRefusal("failed", "The administrator declined.")).toBe(
    "The administrator declined.",
  );
  expect(lockedUseRefusal(undefined, "  ")).toBe("Something went wrong. Try again.");
});

test("the row stays off the page without a screen helper, before an answer, and on other OSes", () => {
  const on = { state: "on" } as const;
  const off = { state: "off" } as const;
  expect(lockedUseShown({ screenUnavailable: true, status: on, hostIsMac: true })).toBe(false);
  expect(lockedUseShown({ screenUnavailable: false, status: undefined, hostIsMac: true })).toBe(
    false,
  );
  expect(lockedUseShown({ screenUnavailable: false, status: off, hostIsMac: false })).toBe(false);
  expect(lockedUseShown({ screenUnavailable: false, status: off, hostIsMac: true })).toBe(true);
  expect(lockedUseShown({ screenUnavailable: false, status: on, hostIsMac: false })).toBe(true);
});

test("failure wording never determines whether installation is available", () => {
  for (const unavailable of [undefined, false]) {
    const status = {
      state: "installFailed",
      reason: "A dependency is not yet implemented",
      unavailable,
    } as const;
    expect(lockedUseUnavailable(status)).toBe(false);
    expect(lockedUseLabel(status)).toEqual({ label: "Install failed", tone: "failed" });
  }
});
