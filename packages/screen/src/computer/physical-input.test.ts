import { expect, it } from "vitest";
import { ScreenCowork } from "../cowork.ts";
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

const activeNotes = async () => ({
  apps: [{ bundleId: "notes", name: "Notes", running: true, active: true }],
});

it.each(["Windows", "macOS"])(
  "%s physical leases, waits and deadlines ignore wall clock jumps; pointers keep epoch time",
  async (platform) => {
    let monotonic = 10_000;
    let epoch = 1_800_000_000_000;
    let lastPersonAt = monotonic;
    const timers = new Set<{ at: number; run: () => void }>();
    let leaseScheduled: (() => void) | undefined;
    const physical =
      platform === "Windows"
        ? windowsPhysicalInput({
            now: () => monotonic,
            idle: async () => ({ idleMs: monotonic - lastPersonAt }),
            apps: activeNotes,
          })
        : macPhysicalInput({
            now: () => monotonic,
            ioreg: async () => `"HIDIdleTime" = ${(monotonic - lastPersonAt) * 1_000_000}`,
            apps: activeNotes,
          });
    const clock = {
      now: () => monotonic,
      set(ms: number, run: () => void) {
        const timer = { at: monotonic + ms, run };
        timers.add(timer);
        if (ms === 3_000) leaseScheduled?.();
        return () => void timers.delete(timer);
      },
    };
    const advance = (ms: number) => {
      monotonic += ms;
      for (const timer of timers) {
        if (timer.at <= monotonic && timers.delete(timer)) timer.run();
      }
    };
    const cowork = new ScreenCowork({ clock, epochNow: () => epoch, physical });
    const sampled = new Promise<void>((resolve) => {
      leaseScheduled = resolve;
    });
    const turn = cowork.turn(["notes"]);
    const waiting = turn.wait();
    await sampled;
    epoch -= 86_400_000;
    advance(1_000);
    expect(cowork.personActive(["notes"])).toBe(true);
    expect(await physical.lastInputAt()).toBe(lastPersonAt);
    epoch += 172_800_000;
    expect(cowork.personActive(["notes"])).toBe(true);
    advance(2_000);
    expect(await waiting).toMatchObject({ busy: false, waitedMs: 3_000 });
    expect(cowork.personActive(["notes"])).toBe(false);
    cowork.acted("notes", { x: 5, y: 7 }, "click");
    expect(cowork.pointer(["notes"])).toMatchObject({ at: epoch });

    // A wall-clock jump cannot reset a request's minute budget across retries.
    const bounded = cowork.turn(["notes"]);
    lastPersonAt = monotonic;
    cowork.personInput(["notes"]);
    const boundedWait = bounded.wait();
    epoch -= 86_400_000;
    advance(60_000);
    lastPersonAt = monotonic;
    cowork.personInput(["notes"]);
    expect(await boundedWait).toMatchObject({ busy: true });
    epoch += 172_800_000;
    expect(await bounded.wait()).toMatchObject({ busy: true });
  },
);
