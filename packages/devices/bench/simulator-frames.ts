import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { jpegDimensions } from "../src/jpeg.ts";
import { SimulatorFrames } from "../src/simulator-frames.ts";

/*
 * Time per Simulator frame through `SimulatorFrames`: decode, fit to half size, re-encode as
 * JPEG at about quality 70. Run with a Simulator screenshot as JPEG:
 *   xcrun simctl io booted screenshot --type=jpeg /tmp/frame.jpg
 *   ACE_BENCH_FRAME=/tmp/frame.jpg bun packages/devices/bench/simulator-frames.ts
 */
const path = process.env["ACE_BENCH_FRAME"];
if (!path) throw new Error("Set ACE_BENCH_FRAME to a Simulator screenshot (JPEG)");
const source = await readFile(path);
const { width, height } = jpegDimensions(source);
const count = Number(process.env["ACE_BENCH_COUNT"] ?? 200);
let published = 0;
let outBytes = 0;
let outSize = "";
let done: (() => void) | undefined;
const frames = new SimulatorFrames({
  fps: 1000,
  now: () => performance.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  publish(image) {
    published++;
    outBytes = image.bytes.length;
    outSize = `${image.width}x${image.height}`;
    done?.();
  },
  failure(error) {
    throw error;
  },
});
// Half the native size, and a budget that makes the quality about 70.
const fps = 30;
const bitrate = Math.round((70 / 85) * source.length * 8 * fps);
frames.idle({
  codec: "jpeg",
  maxWidth: Math.round(width / 2),
  maxHeight: Math.round(height / 2),
  fps,
  bitrate,
});
const one = async () => {
  const next = new Promise<void>((resolve) => (done = resolve));
  frames.hold(source, width, height);
  await frames.replay();
  await next;
};
for (let index = 0; index < 10; index++) await one();
const start = performance.now();
for (let index = 0; index < count; index++) await one();
const elapsed = performance.now() - start;
await frames.stop();
process.stdout.write(
  `${width}x${height} (${(source.length / 1024).toFixed(0)} KiB) -> ${outSize} (${(outBytes / 1024).toFixed(0)} KiB): ` +
    `${(elapsed / count).toFixed(2)} ms/frame over ${published - 10} frames, ` +
    `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
);
