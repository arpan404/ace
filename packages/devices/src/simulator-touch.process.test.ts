import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const udid = "11111111-1111-4111-8111-111111111111";
const runtime: DeviceRuntime = {
  now: () => 1000,
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** A capture of a fake serve-sim whose screen is 1206 x 2622 points. */
async function capture(options: { turned?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "sim-touch-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1", udid, options);
  const platform = new DevicePlatform({
    platform: "darwin",
    home,
    env: { PATH: home },
    async probe(_command, args) {
      return {
        stdout:
          args[0] === "-p"
            ? "/Applications/Xcode.app/Contents/Developer"
            : JSON.stringify({
                devices: { iOS: [{ udid, name: "iPhone", state: "Booted", isAvailable: true }] },
              }),
        stderr: "",
        code: 0,
      };
    },
  });
  onTestFinished(() => platform.close());
  const frames: Frame[] = [];
  const failures: unknown[] = [];
  const live = await startCapture({
    device: { id: `ios:${udid}`, name: "iPhone", platform: "ios", state: "booted" },
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: (frame) => frames.push(frame),
    failure: (error) => failures.push(error),
  });
  onTestFinished(() => live.stop());
  return { sim, live, frames, failures };
}

it("two fingers on a Simulator become one two-finger touch, and the finger left down carries on", async () => {
  const { sim, live, failures } = await capture();
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  const pointer = (phase: "down" | "move" | "up", pointerId: number, x = 0, y = 0) =>
    input({ kind: "pointer", phase, pointerId, x, y }, () => {});

  await pointer("down", 0, 603, 1311);
  await pointer("down", 1, 301.5, 655.5);
  await pointer("move", 1, 904.5, 1966.5);
  await pointer("up", 0);
  await pointer("move", 1, 301.5, 655.5);
  await pointer("down", 0, 603, 1311);
  await live.releaseInput?.();

  await expect.poll(() => sim.hid.length).toBe(8);
  expect(sim.hid).toEqual([
    [3, { type: "begin", x: 0.5, y: 0.5 }],
    // The first finger is not lifted when the second joins: that would be a tap.
    [5, { type: "begin", x1: 0.5, y1: 0.5, x2: 0.25, y2: 0.25 }],
    [5, { type: "move", x1: 0.5, y1: 0.5, x2: 0.75, y2: 0.75 }],
    [5, { type: "end", x1: 0.5, y1: 0.5, x2: 0.75, y2: 0.75 }],
    // The finger left down touches again once it moves.
    [3, { type: "begin", x: 0.75, y: 0.75 }],
    [3, { type: "move", x: 0.25, y: 0.25 }],
    // The finger already down keeps the first slot.
    [5, { type: "begin", x1: 0.25, y1: 0.25, x2: 0.5, y2: 0.5 }],
    // Taking control away lifts both fingers.
    [5, { type: "end", x1: 0.25, y1: 0.25, x2: 0.5, y2: 0.5 }],
  ]);
  expect(failures).toEqual([]);
});

it("a third finger on a Simulator is refused without touching the screen", async () => {
  const { sim, live } = await capture();
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  await expect(
    input({ kind: "pointer", phase: "down", pointerId: 2, x: 10, y: 10 }, () => {}),
  ).rejects.toMatchObject({ code: "not_supported" });
  expect(sim.hid).toEqual([]);
});

it("Simulator frames tell viewers how far to turn the portrait picture when the device turns", async () => {
  const { sim, frames } = await capture();
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames.at(-1)?.header.rotation).toBe(0);
  // The capture first turned the Simulator to match what serve-sim announced.
  await expect.poll(() => sim.rotations()).toBe(1);

  // The picture itself need not change: the turn alone republishes the latest frame.
  sim.orient("landscape_left");
  await expect.poll(() => frames.at(-1)?.header.rotation).toBe(90);
  sim.orient("landscape_right");
  await expect.poll(() => frames.at(-1)?.header.rotation).toBe(270);
  sim.orient("portrait_upside_down");
  await expect.poll(() => frames.at(-1)?.header.rotation).toBe(180);
  sim.orient("portrait");
  await expect.poll(() => frames.at(-1)?.header.rotation).toBe(0);
  expect(frames.at(-1)?.header).toMatchObject({ width: 201, height: 437, codec: "jpeg" });
});

it("a Simulator left turned by an earlier session is turned to match the orientation its pictures carry", async () => {
  // A fresh serve-sim announces portrait, but the Simulator was left on its side: without the
  // turn, viewers would draw a sideways picture in an upright frame.
  const { sim, frames } = await capture({ turned: "landscape_left" });
  await expect.poll(() => sim.orientation()).toBe("portrait");
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames.at(-1)?.header.rotation).toBe(0);
});

it("a Simulator's side buttons press the HID codes Xcode's device chrome gives them", async () => {
  const { sim, live } = await capture();
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  for (const key of ["volumeUp", "volumeDown", "action", "power", "side"] as const)
    await input({ kind: "key", key }, () => {});

  await expect.poll(() => sim.hid.length).toBe(5);
  expect(sim.hid).toEqual([
    [4, { page: 12, usage: 233 }],
    [4, { page: 12, usage: 234 }],
    [4, { page: 11, usage: 45 }],
    [4, { button: "power", page: 12, usage: 48 }],
    // Apple Watch's side button.
    [4, { page: 12, usage: 149 }],
  ]);
});

it("typing on a Simulator brings back the on-screen keyboard its keys hid, unless the person hid it", async () => {
  const { sim, live } = await capture();
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  const toggles = () => sim.hid.filter((entry) => Array.isArray(entry) && entry[0] === 12).length;

  // Typed keys put iOS into hardware-keyboard mode; the toggle after them undoes that.
  await input({ kind: "type", text: "hi" }, () => {});
  await expect.poll(toggles).toBe(1);
  // The keyboard key is Simulator's Toggle Software Keyboard: here the person hides it…
  await input({ kind: "key", key: "keyboard" }, () => {});
  await expect.poll(toggles).toBe(2);
  // …so text typed now leaves it hidden.
  await input({ kind: "type", text: "x" }, () => {});
  // Shown again, Return keeps it shown.
  await input({ kind: "key", key: "keyboard" }, () => {});
  await input({ kind: "key", key: "enter" }, () => {});
  await expect.poll(toggles).toBe(4);
  expect(sim.hid).toEqual([
    [12, {}],
    [12, {}],
    [12, {}],
    [12, {}],
  ]);
});

it("a key iOS hardware doesn't have is refused without reaching the Simulator", async () => {
  const { sim, live } = await capture();
  const input = live.input;
  if (!input) throw new Error("Missing native input");
  await expect(input({ kind: "key", key: "back" }, () => {})).rejects.toMatchObject({
    code: "not_supported",
  });
  expect(sim.hid).toEqual([]);
});
