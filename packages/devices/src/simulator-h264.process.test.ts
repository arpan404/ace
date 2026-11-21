import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim as serveSim } from "./testing/fake-serve-sim.ts";

const udid = "11111111-1111-4111-8111-111111111111";
const fakeServeSim = (
  home: string,
  version: string,
  options?: { video?: boolean; notice?: string },
) => serveSim(home, version, udid, options);
function platformFor(home: string) {
  return new DevicePlatform({
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
}
const runtime: DeviceRuntime = {
  now: () => 1000,
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
const device = {
  id: `ios:${udid}`,
  name: "iPhone",
  platform: "ios" as const,
  state: "booted" as const,
};
const video = {
  codec: "h264" as const,
  maxWidth: 800,
  maxHeight: 1600,
  fps: 60,
  bitrate: 12000000,
};

it("without ace-media a live view is refused, saying why, and agents keep their JPEG stills", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-nomedia-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  const frames: Frame[] = [];
  const failures: unknown[] = [];
  const capture = await startCapture({
    device,
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: (frame) => frames.push(frame),
    failure: (error) => failures.push(error),
  });
  onTestFinished(() => capture.stop());
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  await expect(capture.configure?.(video)).rejects.toMatchObject({
    code: "command_failed",
    message: expect.stringContaining("ace-media"),
  });
  // The daemon never reads serve-sim's video itself; the capture lives on for agents' stills.
  expect(sim.avcc.length).toBe(0);
  expect(failures).toEqual([]);
  expect(frames.every((frame) => frame.header.codec === "jpeg")).toBe(true);
});

it("a tree ref taps its element through serve-sim's touch socket; edge swipes and rotation follow the screen", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-ax-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  const capture = await startCapture({
    device,
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: () => {},
    failure: () => {},
  });
  onTestFinished(() => capture.stop());
  if (!capture.ui || !capture.input) throw new Error("Capture has no accessibility or input");
  const tree = await capture.ui.tree({});
  const general = tree.nodes[0]?.children[0];
  expect(general).toMatchObject({ name: "General", bounds: { x: 0, y: 900, w: 1206, h: 150 } });
  const found = await capture.ui.find({ query: { name: "general" } });
  expect(found.nodes.map((node) => node.ref)).toEqual([general?.ref]);

  expect(await capture.ui.act({ ref: general?.ref, action: "press" }, () => {})).toMatchObject({
    boundsCentre: { x: 603, y: 975 },
  });
  await expect.poll(() => sim.hid.length).toBe(2);
  expect(sim.hid).toEqual([
    [3, { type: "begin", x: 0.5, y: 975 / 2622 }],
    [3, { type: "end", x: 0.5, y: 975 / 2622 }],
  ]);
  await expect(capture.ui.act({ ref: "i_stale", action: "press" }, () => {})).rejects.toThrow(
    "stale",
  );

  // A swipe up from the bottom edge is a system edge gesture (go home); a tap there is not.
  await capture.input(
    { kind: "swipe", x: 603, y: 2615, toX: 603, toY: 1300, durationMs: 16 },
    () => {},
  );
  await expect.poll(() => sim.hid.length).toBe(5);
  expect(
    sim.hid.slice(2).map((message) => (message as [number, { edge?: number }])[1].edge),
  ).toEqual([3, 3, 3]);
  await capture.input({ kind: "tap", x: 603, y: 2615 }, () => {});
  await expect.poll(() => sim.hid.length).toBe(7);
  expect(JSON.stringify(sim.hid.slice(5))).not.toContain("edge");

  await capture.input({ kind: "key", key: "rotate" }, () => {});
  await expect.poll(() => sim.orientation()).toBe("landscape_left");
});

it("a serve-sim version ace hasn't pinned is not driven", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-version-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const sim = await fakeServeSim(home, "9.9.9");
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  await expect(
    startCapture({
      device,
      streamId: "native",
      fps: 30,
      platform,
      runtime,
      env: { PATH: home },
      publish: () => {},
      failure: () => {},
    }),
  ).rejects.toMatchObject({ code: "tool_missing", message: expect.stringContaining("9.9.9") });
  expect(sim.opened()).toBe(0);
  expect(sim.mjpegOpen()).toBe(0);
});

it("a notice serve-sim prints before announcing its helper doesn't stop the stream", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-notice-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await fakeServeSim(home, "0.1.49-beta.139.1", {
    notice: "\u001b[90mPort 3100 busy, killing listener pid(s): 4242\u001b[0m",
  });
  const platform = platformFor(home);
  onTestFinished(() => platform.close());
  const frames: Frame[] = [];
  const capture = await startCapture({
    device,
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: (frame) => frames.push(frame),
    failure: () => {},
  });
  onTestFinished(() => capture.stop());
  // The stream serve-sim announced after its notice runs: its pictures arrive.
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.header.codec === "jpeg")).toBe(true);
});
