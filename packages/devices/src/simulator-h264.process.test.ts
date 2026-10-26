import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim as serveSim } from "./testing/fake-serve-sim.ts";

const udid = "11111111-1111-4111-8111-111111111111";
const fakeServeSim = (home: string, version: string, options?: { video?: boolean }) =>
  serveSim(home, version, udid, options);
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

it("a live view gets serve-sim's H.264 untouched, and agents get JPEG back once nobody watches", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-h264-"));
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
  expect(frames[0]?.header.codec).toBe("jpeg");

  expect(await capture.configure?.(video)).toEqual({ codec: "h264" });
  const key = frames.find((frame) => frame.header.codec === "h264");
  // Native size whatever the viewer's budget: nothing is scaled or re-encoded.
  expect(key?.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    videoCodec: "avc1.640033",
    width: 1206,
    height: 2622,
    scale: 1,
  });
  expect(key?.payload.toString("hex")).toBe(
    [
      "0000000127640033ac13143c04c0149e6a9a81010103c20108f8",
      "0000000128ee3cb0",
      "00000001258801",
    ].join(""),
  );
  await expect.poll(sim.mjpegOpen).toBe(0);

  sim.delta(0x55);
  await expect.poll(() => frames.at(-1)?.payload.toString("hex")).toBe("000000012155");
  expect(frames.at(-1)?.header).toMatchObject({ codec: "h264", keyframe: false });

  // A keyframe request opens a fresh subscription and leaves only that one open.
  await capture.keyframe?.();
  expect(sim.opened()).toBe(2);
  expect(frames.at(-1)?.payload.subarray(-3).toString("hex")).toBe("258802");
  await expect.poll(() => sim.avcc.length).toBe(1);
  const sequences = frames.map((frame) =>
    frame.header.version === 1 ? frame.header.sequence : -1,
  );
  expect(sequences).toEqual(sequences.map((_, index) => index));

  expect(await capture.configure?.({ ...video, codec: "jpeg" })).toEqual({ codec: "jpeg" });
  await expect.poll(() => frames.at(-1)?.header.codec).toBe("jpeg");
  await expect.poll(() => sim.avcc.length).toBe(0);
  expect(failures).toEqual([]);
});

it("serve-sim video that won't start refuses the live view instead of handing it JPEG", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-novideo-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await fakeServeSim(home, "0.1.49-beta.139.1", { video: false });
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
    hint: expect.stringContaining("download device tools again in Devices (serve-sim 0.1.49-beta.139.1)"),
  });
  // The capture itself lives on for agents' stills.
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
