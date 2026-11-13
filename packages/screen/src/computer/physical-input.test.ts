import { expect, it } from "vitest";
import {
  frontmostApp,
  hidIdleMs,
  macPhysicalInput,
  windowsPhysicalInput,
} from "./physical-input.ts";

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

it("Windows attributes recent session input to the helper's frontmost app", async () => {
  let now = 10_000;
  let idleMs = 750;
  const input = windowsPhysicalInput({
    now: () => now,
    idle: async () => ({ idleMs, newerHelperField: true }),
    apps: async () => ({
      apps: [
        { bundleId: "notepad.exe", name: "Notepad", running: true },
        { bundleId: "CalculatorApp.exe", name: "Calculator", running: true, active: true },
      ],
    }),
  });
  expect(await input.lastInputAt()).toBe(9_250);
  expect(await input.frontmost()).toBe("CalculatorApp.exe");
  now = 12_000;
  idleMs = 100;
  expect(await input.lastInputAt()).toBe(11_900);
});

it.each([
  undefined,
  {},
  { idleMs: null },
  { idleMs: -1 },
  { idleMs: "100" },
  { idleMs: 0x1_0000_0000 },
])("Windows treats unavailable or malformed idle data %j as unknown input", async (reply) => {
  const input = windowsPhysicalInput({
    now: () => 10_000,
    idle: async () => reply,
    apps: async () => undefined,
  });
  expect(await input.lastInputAt()).toBeUndefined();
  expect(await input.frontmost()).toBeUndefined();
});

it("Windows propagates an idle-source failure to the presence boundary", async () => {
  const input = windowsPhysicalInput({
    now: () => 10_000,
    idle: async () => {
      throw new Error("helper unavailable");
    },
    apps: async () => undefined,
  });
  await expect(input.lastInputAt()).rejects.toThrow("helper unavailable");
});
