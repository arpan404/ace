import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { DevicePlatform, startCapture } from "../src/index.ts";

/*
 * Frames per second an Android emulator's live view gets, through ace's own capture: encoded on
 * the host by the screen helper (`ACE_FRAME_ENCODER=<built helper>`, an emulator booted with
 * `-grpc <console + 3000> -grpc-use-token`), or by scrcpy inside the emulator (unset). Opt-in:
 * it drives a real, booted emulator; keep its screen moving while it runs, e.g.
 *   adb -s emulator-5554 shell 'while true; do input swipe 540 1800 540 400 2000; input swipe 540 400 540 1800 2000; done'
 *   ACE_FRAME_ENCODER=native/screen-helper/build/ace-screen-helper node packages/devices/bench/emulator-video.ts emulator-5554
 * Measured 2026-10-20 on a loaded M4 Max (load average about 40): scrcpy 12–22 fps median with
 * 1 s stalls, host-encoded 53–60; on a quieter Mac both reach 60, scrcpy at half the asked bit rate.
 */
const serial = process.argv[2];
if (!serial) throw new Error("Name a booted emulator, e.g. emulator-5554");
const box = Number(process.argv[3] ?? 2880);
const encoder = process.env["ACE_FRAME_ENCODER"];
const tools = await mkdtemp(join(tmpdir(), "ace-emulator-video-"));
const platform = new DevicePlatform({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  toolsDirectory: tools,
  node: process.execPath,
  ...(encoder ? { frameEncoder: encoder } : {}),
});
const device = (await platform.list()).find((entry) => entry.serial === serial);
if (!device) throw new Error(`${serial} is not booted`);
const times: number[] = [];
let bytes = 0;
const capture = await startCapture({
  device,
  streamId: "bench",
  fps: 60,
  platform,
  env: process.env,
  runtime: {
    now: Date.now,
    id: () => crypto.randomUUID(),
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    spawn: spawnRawSupervised,
  },
  publish(frame) {
    if (frame.header.codec !== "h264") return;
    times.push(performance.now());
    bytes += frame.payload.length;
  },
  failure: (error) => console.error("capture failed", error),
});
await capture.configure?.({
  codec: "h264",
  maxWidth: Math.round(box / 2),
  maxHeight: box,
  fps: 60,
  bitrate: 8_000_000,
});
await new Promise((resolve) => setTimeout(resolve, 6000));
times.length = 0;
bytes = 0;
const start = performance.now();
await new Promise((resolve) => setTimeout(resolve, 10_000));
const perSecond = Array.from(
  { length: 10 },
  (_, index) =>
    times.filter((at) => at >= start + index * 1000 && at < start + (index + 1) * 1000).length,
);
let longestGap = 0;
for (let index = 1; index < times.length; index++)
  longestGap = Math.max(longestGap, (times[index] ?? 0) - (times[index - 1] ?? 0));
console.log(
  JSON.stringify({
    path: encoder ? "host (screen helper)" : "scrcpy (in the emulator)",
    perSecond,
    median: perSecond.toSorted((a, b) => a - b)[5],
    longestGapMs: Math.round(longestGap),
    megabitsPerSecond: Number(((bytes * 8) / 10 / 1e6).toFixed(2)),
  }),
);
await capture.stop();
await platform.close();
await rm(tools, { recursive: true, force: true });
