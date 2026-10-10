import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, onTestFinished, vi } from "vitest";
import { findExecutable } from "@ace/provider-kit/discovery";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { resolveAndroidSDK } from "./sdk.ts";
import { ScreenManager, type Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type Device } from "./index.ts";
import type { DeviceRuntime } from "./runtime.ts";

/*
 * Live view on real devices: the opt-in counterpart of capture.process.test.ts. Each test boots
 * only the explicitly selected, initially shut down device and shuts it down again.
 */
const live = process.env["ACE_DEVICE_LIVE"] === "1";
const androidAvd = process.env["ACE_DEVICE_LIVE_ANDROID_AVD"];
const iosUuid = process.env["ACE_DEVICE_LIVE_IOS_UUID"];
let ids = 0;
const runtime: DeviceRuntime = {
  now: Date.now,
  id: () => `live-${++ids}`,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  spawn: spawnRawSupervised,
};

async function bootSelected(devices: DevicePlatform, id: string): Promise<Device> {
  const selected = (await devices.list()).find((device) => device.id === id);
  if (!selected) throw new Error("The explicitly selected device is not installed");
  if (selected.state !== "shutdown")
    throw new Error("Live capture tests require an initially shut down device");
  await devices.boot(selected);
  onTestFinished(async () => {
    await devices.shutdown(selected).catch(() => {});
  }, 60_000);
  const booted = (await devices.list()).find((device) => device.id === id);
  if (booted?.state !== "booted") throw new Error("The selected device did not boot");
  return booted;
}

function frames() {
  const received: Frame[] = [];
  const failures: unknown[] = [];
  return {
    received,
    failures,
    publish: (frame: Frame) => received.push(frame),
    failure: (error: unknown) => failures.push(error),
    /** The first frame after `from` that satisfies `match`. */
    next: (from: number, match: (frame: Frame) => boolean, timeout = 60_000) =>
      vi.waitFor(
        () => {
          if (failures.length) throw new Error(`Capture failed: ${String(failures[0])}`);
          const found = received.slice(from).find(match);
          const last = received.at(-1)?.header;
          if (!found)
            throw new Error(
              `No matching frame among ${received.length - from} new of ${received.length}` +
                (last ? `; last ${last.codec} ${last.width}x${last.height}` : ""),
            );
          return found;
        },
        { timeout, interval: 100 },
      ),
  };
}

const jpeg = (frame: Frame) =>
  frame.header.codec === "jpeg" && frame.payload[0] === 0xff && frame.payload[1] === 0xd8;
const landscape = (frame: Frame) => frame.header.width > frame.header.height;

/** A JPEG frame's pixels as RGB, three bytes per pixel, row by row. */
async function pixels(frame: Frame): Promise<Uint8Array> {
  const ffmpeg = await findExecutable("ffmpeg", process.env);
  if (!ffmpeg) throw new Error("Live input tests need ffmpeg");
  const child = spawn(
    ffmpeg,
    ["-v", "error", "-f", "mjpeg", "-i", "pipe:0"].concat([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]),
  );
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin.end(frame.payload);
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`ffmpeg exited with ${String(code)}`);
  return new Uint8Array(Buffer.concat(chunks));
}

const brightness = (rgb: Uint8Array) => rgb.reduce((sum, value) => sum + value, 0) / rgb.length;

const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1];
const yellow = (rgb: Uint8Array, pixel: number) =>
  (rgb[pixel * 3] ?? 0) > 160 &&
  (rgb[pixel * 3 + 1] ?? 0) > 160 &&
  (rgb[pixel * 3 + 2] ?? 255) < 110;

/**
 * Where the pointer location overlay's yellow touch marker appeared between two pictures: the
 * median of the pixels that turned yellow, so other yellow on screen does not move it.
 */
function markerAt(before: Uint8Array, after: Uint8Array, width: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let pixel = 0; pixel < after.length / 3; pixel++) {
    if (!yellow(after, pixel) || yellow(before, pixel)) continue;
    xs.push(pixel % width);
    ys.push(Math.floor(pixel / width));
  }
  return { x: median(xs), y: median(ys) };
}

it.skipIf(!live || !androidAvd)(
  "a real emulator streams frames that follow its rotation, and a press lands where they show it",
  async () => {
    const home = process.env["ACE_TEST_REAL_HOME"] ?? homedir();
    const devices = new DevicePlatform({ platform: process.platform, home, env: process.env });
    onTestFinished(() => devices.close());
    const device = await bootSelected(devices, `android:${androidAvd}`);
    const { adb } = await resolveAndroidSDK({ platform: process.platform, home, env: process.env });
    const serial = device.serial;
    if (!serial) throw new Error("The booted emulator has no adb serial");
    // Android's pointer location overlay marks the touch point.
    const pointerLocation = (on: boolean) =>
      promisify(execFile)(
        adb,
        ["-s", serial, "shell", "settings", "put", "system"].concat([
          "pointer_location",
          on ? "1" : "0",
        ]),
      );
    await pointerLocation(true);
    onTestFinished(async () => {
      await pointerLocation(false).catch(() => {});
    });
    const stream = frames();
    const capture = await startCapture({
      device,
      streamId: "live-android",
      fps: 10,
      platform: devices,
      runtime,
      env: process.env,
      publish: stream.publish,
      failure: stream.failure,
    });
    onTestFinished(() => capture.stop());
    const first = await stream.next(0, jpeg);
    expect(first.header.width).toBeGreaterThan(100);
    expect(first.header.height).toBeGreaterThan(100);
    const before = landscape(first);

    /** Press at a point of the stream's picture and find the touch marker there. */
    const pressShows = async (orientation: boolean) => {
      // A booting screen stays black, and drops touches, until the home screen draws.
      await vi.waitFor(
        async () => {
          const shown = stream.received.findLast(
            (frame) => jpeg(frame) && landscape(frame) === orientation,
          );
          if (!shown) throw new Error("No frame in this orientation yet");
          expect(brightness(await pixels(shown))).toBeGreaterThan(16);
        },
        { timeout: 180_000, interval: 1_000 },
      );
      await sleep(3_000);
      const still = stream.received.findLast(
        (frame) => jpeg(frame) && landscape(frame) === orientation,
      );
      if (!still) throw new Error("The stream lost its orientation");
      const { width, height, scale = 1 } = still.header;
      const x = Math.round(width * 0.37),
        y = Math.round(height * 0.61);
      // Input is in device pixels; a frame may be downscaled from them by its header's scale.
      const at = { x: Math.round(x / scale), y: Math.round(y / scale) };
      const mark = stream.received.length;
      await devices.input(device, { kind: "pointer", phase: "down", ...at });
      onTestFinished(() => devices.input(device, { kind: "pointer", phase: "up", ...at }));
      const idle = await pixels(still);
      // The decoder keeps the last few pictures until more arrive; a held finger trembles.
      let tremble = 0;
      await vi.waitFor(
        async () => {
          tremble ^= 1;
          await devices.input(device, {
            kind: "pointer",
            phase: "move",
            x: at.x + tremble,
            y: at.y,
          });
          const pressed = stream.received
            .slice(mark)
            .findLast((frame) => jpeg(frame) && frame.header.width === width);
          if (!pressed || pressed.header.height !== height) throw new Error("No frame yet");
          const marker = markerAt(idle, await pixels(pressed), width);
          expect(Math.abs((marker.x ?? -100) - x)).toBeLessThanOrEqual(4);
          expect(Math.abs((marker.y ?? -100) - y)).toBeLessThanOrEqual(4);
        },
        { timeout: 15_000, interval: 500 },
      );
      await devices.input(device, { kind: "pointer", phase: "up", ...at });
    };
    await pressShows(before);

    // A quarter turn reaches the device through adb and shows in the stream once capture
    // restarts at the new size; a press in the turned picture still lands where it shows.
    await devices.input(device, { kind: "key", key: "rotate" });
    const mark = stream.received.length;
    await capture.restart?.();
    const turned = await stream.next(mark, (frame) => jpeg(frame) && landscape(frame) !== before);
    expect(turned.header.width).toBeGreaterThan(100);
    await pressShows(!before);
  },
  600_000,
);

it.skipIf(!live || !iosUuid || process.platform !== "darwin")(
  "a real Simulator window streams portrait frames through the screen helper",
  async () => {
    const root = new URL("../../../native/screen-helper/", import.meta.url).pathname;
    const screen = new ScreenManager({
      command: join(root, "build/ace-screen-helper"),
      // Opt-in runs use the grants of the terminal that runs them.
      args: ["--inherit-responsibility"],
      platform: "darwin",
      env: {},
      nextId: () => `live-screen-${++ids}`,
      recordingDirectory: join(process.env["TMPDIR"] ?? "/tmp", "ace-live-screen"),
      async publishArtifact() {},
    });
    const devices = new DevicePlatform({
      platform: "darwin",
      home: process.env["ACE_TEST_REAL_HOME"] ?? homedir(),
      env: process.env,
      screen,
    });
    onTestFinished(async () => {
      await devices.close();
      await screen.close();
    });
    const device = await bootSelected(devices, `ios:${iosUuid}`);
    const stream = frames();
    const capture = await startCapture({
      device,
      streamId: "live-ios",
      fps: 10,
      platform: devices,
      screen,
      runtime,
      env: process.env,
      publish: stream.publish,
      failure: stream.failure,
    });
    onTestFinished(() => capture.stop());
    const frame = await stream.next(0, (each) => each.payload.length > 0);
    // A phone Simulator window is portrait; a wrong window (Simulator's menu bar, another
    // device) would not be.
    expect(frame.header.height).toBeGreaterThan(frame.header.width);
    expect(frame.header.width).toBeGreaterThan(200);
  },
  600_000,
);
