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
async function capture() {
  const home = await mkdtemp(join(tmpdir(), "sim-touch-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.48", udid);
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
