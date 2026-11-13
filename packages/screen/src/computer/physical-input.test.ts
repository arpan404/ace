import { expect, it } from "vitest";
import { frontmostApp, hidIdleMs, macPhysicalInput } from "./physical-input.ts";

it.each([
  ['  |   "HIDIdleTime" = 2500000000', 2_500],
  ['"HIDIdleTime"=0', 0],
  ["no idle entry", undefined],
])("ioreg's idle time %j reads as %s ms", (output, ms) => {
  expect(hidIdleMs(output)).toBe(ms);
});

it("the last input is now minus the idle time, and the frontmost app is the helper's active one", async () => {
  const input = macPhysicalInput({
    now: () => 10_000,
    ioreg: async () => '"HIDIdleTime" = 1500000000',
    apps: async () => ({
      apps: [
        { bundleId: "com.apple.Safari", name: "Safari", running: true },
        { bundleId: "com.apple.TextEdit", name: "TextEdit", running: true, active: true },
      ],
    }),
  });
  expect(await input.lastInputAt()).toBe(8_500);
  expect(await input.frontmost()).toBe("com.apple.TextEdit");
  expect(frontmostApp(undefined)).toBeUndefined();
});
