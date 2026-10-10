import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
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
  });
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

it.skipIf(!live || !androidAvd)(
  "a real emulator streams decodable frames that follow its rotation",
  async () => {
    const devices = new DevicePlatform({
      platform: process.platform,
      home: process.env["ACE_TEST_REAL_HOME"] ?? homedir(),
      env: process.env,
    });
    onTestFinished(() => devices.close());
    const device = await bootSelected(devices, `android:${androidAvd}`);
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
    // A quarter turn reaches the device through adb and shows in the stream once capture
    // restarts at the new size.
    await devices.input(device, { kind: "key", key: "rotate" });
    const mark = stream.received.length;
    await capture.restart?.();
    const turned = await stream.next(mark, (frame) => jpeg(frame) && landscape(frame) !== before);
    expect(turned.header.width).toBeGreaterThan(100);
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
