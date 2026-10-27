import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { simulatorNeedsTranscode, startSimulatorTranscode } from "./simulator-transcode.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const udid = "11111111-1111-4111-8111-111111111111";

it("a viewer that can't carry serve-sim's stream gets it re-encoded, with room before it flips back", () => {
  const native = { width: 1206, height: 2622 };
  const box = { maxWidth: 1440, maxHeight: 2880 };
  expect(simulatorNeedsTranscode({ transcoding: false, bitrate: 8_000_000, box, native })).toBe(
    false,
  );
  expect(simulatorNeedsTranscode({ transcoding: false, bitrate: 3_000_000, box, native })).toBe(
    true,
  );
  // Once re-encoding, 5.2 Mbit/s isn't enough to go back to serve-sim's 6.
  expect(simulatorNeedsTranscode({ transcoding: true, bitrate: 5_200_000, box, native })).toBe(
    true,
  );
  expect(simulatorNeedsTranscode({ transcoding: true, bitrate: 6_000_000, box, native })).toBe(
    false,
  );
  // An iPad's picture in a phone's panel is re-encoded smaller at any rate.
  const ipad = { width: 2420, height: 1668 };
  expect(
    simulatorNeedsTranscode({ transcoding: false, bitrate: 12_000_000, box, native: ipad }),
  ).toBe(true);
});

it("a viewer is judged against the rate serve-sim actually sends, never less than 6 Mbit/s", () => {
  const native = { width: 1206, height: 2622 };
  const box = { maxWidth: 1440, maxHeight: 2880 };
  // serve-sim sends a big screen at up to 30 Mbit/s: 8 Mbit/s can't carry its busy seconds.
  expect(
    simulatorNeedsTranscode({ transcoding: false, bitrate: 8_000_000, box, native, source: 20e6 }),
  ).toBe(true);
  // A quiet screen measures low; the 6 Mbit/s floor still holds.
  expect(
    simulatorNeedsTranscode({ transcoding: false, bitrate: 4_000_000, box, native, source: 1e6 }),
  ).toBe(true);
  expect(
    simulatorNeedsTranscode({ transcoding: true, bitrate: 19_000_000, box, native, source: 20e6 }),
  ).toBe(false);
});

/**
 * The screen helper's `--transcode` mode, played by a script: half-size H.264 per frame in,
 * `delayMs` later, carrying the time the frame went in with.
 */
const fakeTranscoder = (log: string, delayMs = 0) => `
const fs = require("fs");
let pending = Buffer.alloc(0);
let first = true;
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    if (pending.length < 4) return;
    const length = pending.readUInt32BE(0);
    if (pending.length < 4 + length) return;
    const header = JSON.parse(pending.subarray(4, 4 + length));
    if (pending.length < 4 + length + header.bytes) return;
    pending = pending.subarray(4 + length + header.bytes);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(header) + "\\n");
    if (header.op !== "frame") continue;
    const payload = Buffer.from([0, 0, 0, 1, first ? 0x65 : 0x41, 1]);
    const out = Buffer.from(JSON.stringify({
      version: 2, sessionId: "simulator", seq: header.seq, ts: header.ts, width: 600, height: 1304,
      scale: 1, codec: "h264", keyframe: first, ...(first ? { videoCodec: "avc1.640033" } : {}),
      bytes: payload.length,
    }));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(out.length);
    const packet = Buffer.concat([size, out, payload]);
    setTimeout(() => process.stdout.write(packet), ${delayMs});
    first = false;
  }
});
`;

/** A capture of a stand-in serve-sim whose transcoder is `fakeTranscoder`, on clock `now`. */
async function transcodingCapture(now: () => number, delayMs = 0) {
  const home = await mkdtemp(join(tmpdir(), "sim-transcode-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "transcoder"));
  const log = join(home, "transcoder.log");
  const transcoder = await nodeBinary(
    join(home, "transcoder"),
    "transcode",
    fakeTranscoder(log, delayMs),
  );
  const sim = await fakeServeSim(home, "0.1.49-beta.139.1", udid);
  const platform = new DevicePlatform({
    platform: "darwin",
    home,
    env: { PATH: home },
    frameEncoder: transcoder,
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
  const runtime: DeviceRuntime = {
    now,
    id: () => "native",
    spawn: spawnRawSupervised,
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  };
  const frames: Frame[] = [];
  const capture = await startCapture({
    device: { id: `ios:${udid}`, name: "iPhone", platform: "ios", state: "booted" },
    streamId: "native",
    fps: 30,
    platform,
    runtime,
    env: { PATH: home },
    publish: (frame) => frames.push(frame),
    failure: () => {},
  });
  onTestFinished(() => capture.stop());
  return { capture, frames, sim, log };
}

it("serve-sim's stream passes through for a good link and is re-encoded smaller for a thin one", async () => {
  const { capture, frames, log } = await transcodingCapture(() => 1000);
  const video = { codec: "h264" as const, maxWidth: 1440, maxHeight: 2880, fps: 60 };

  await capture.configure?.({ ...video, bitrate: 8_000_000 });
  const native = await expect
    .poll(() => frames.find((frame) => frame.header.codec === "h264"))
    .toBeTruthy()
    .then(() => frames.find((frame) => frame.header.codec === "h264"));
  expect(native?.header.width).not.toBe(600);

  // The link thins: the next pictures are the transcoder's, at the viewer's rate.
  await capture.configure?.({ ...video, bitrate: 2_000_000 });
  await capture.keyframe?.();
  await expect
    .poll(() => frames.some((frame) => frame.header.width === 600 && frame.header.keyframe))
    .toBe(true);
  const sent = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(sent).toContainEqual(expect.objectContaining({ op: "settings", bitrate: 2_000_000 }));
  // A downscaled picture says how it maps to the Simulator's own pixels.
  const small = frames.find((frame) => frame.header.width === 600);
  expect(small?.header.scale).toBeCloseTo(600 / (native?.header.width ?? 1));

  // The link recovers: serve-sim's own stream again, from its next keyframe.
  const before = frames.length;
  await capture.configure?.({ ...video, bitrate: 8_000_000 });
  await capture.keyframe?.();
  await expect
    .poll(() =>
      frames
        .slice(before)
        .some((frame) => frame.header.codec === "h264" && frame.header.width !== 600),
    )
    .toBe(true);
});

/** A transcoder that reads nothing until `go` exists, then logs every packet header it gets. */
const stalledTranscoder = (log: string, go: string) => `
const fs = require("fs");
let pending = Buffer.alloc(0);
const read = () => process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    if (pending.length < 4) return;
    const length = pending.readUInt32BE(0);
    if (pending.length < 4 + length) return;
    const header = JSON.parse(pending.subarray(4, 4 + length));
    if (pending.length < 4 + length + header.bytes) return;
    pending = pending.subarray(4 + length + header.bytes);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(header) + "\\n");
  }
});
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  clearInterval(wait);
  read();
}, 10);
`;

it("a transcoder that falls behind skips to serve-sim's next IDR and still gets every setting", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-transcode-stall-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "bin"));
  const log = join(home, "received.log");
  const go = join(home, "go");
  const helper = await nodeBinary(join(home, "bin"), "transcode", stalledTranscoder(log, go));
  let keyframesAsked = 0;
  const transcode = startSimulatorTranscode({
    helper,
    runtime: { spawn: spawnRawSupervised },
    env: { PATH: process.env["PATH"] ?? "" },
    frame: () => {},
    failed: () => {},
    needKeyframe: () => keyframesAsked++,
  });
  onTestFinished(() => transcode.stop());
  const unit = Buffer.alloc(256 * 1024, 1);
  // The transcoder stalls: an IDR and many deltas pile up until its pipe is full.
  let seq = 0;
  transcode.push(unit, true, seq++, 0);
  for (let index = 0; index < 40; index++) transcode.push(unit, false, seq++, 0);
  expect(keyframesAsked).toBe(1);
  // A setting and a keyframe request made meanwhile must still arrive.
  transcode.settings({ bitrate: 2_000_000, maxWidth: 600, maxHeight: 1304 });
  transcode.keyframe();
  await writeFile(go, "");
  const received = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; seq?: number; keyframe?: boolean });
  await expect.poll(async () => (await received()).some((h) => h.op === "keyframe")).toBe(true);
  // Deltas after the drop refer to a picture the transcoder never got: they wait for the IDR.
  const afterDrop = seq;
  transcode.push(unit, false, seq++, 0);
  transcode.push(unit, true, seq++, 0);
  transcode.push(unit, false, seq++, 0);
  await expect.poll(async () => (await received()).at(-1)?.seq).toBe(seq - 1);

  const all = await received();
  expect(all).toContainEqual(expect.objectContaining({ op: "settings", bitrate: 2_000_000 }));
  const frames = all.filter((h) => h.op === "frame");
  // Up to the first gap the pictures are consecutive from the first IDR...
  const firstGap = frames.findIndex(
    (h, index) => index > 0 && h.seq !== (frames[index - 1]?.seq ?? 0) + 1,
  );
  expect(firstGap).toBeGreaterThan(0);
  expect(frames[0]).toMatchObject({ seq: 0, keyframe: true });
  // ...and the first picture after it is serve-sim's next IDR, then what follows it.
  expect(frames.slice(firstGap).map((h) => [h.seq, h.keyframe])).toEqual([
    [afterDrop + 1, true],
    [afterDrop + 2, false],
  ]);
  expect(keyframesAsked).toBe(1);
});

it("a viewer watching serve-sim pass through moves to the transcoder once the screen gets busier than its link", async () => {
  let clock = 1000;
  const { capture, frames, sim } = await transcodingCapture(() => clock);
  const video = { codec: "h264" as const, maxWidth: 1440, maxHeight: 2880, fps: 60 };
  await capture.configure?.({ ...video, bitrate: 8_000_000 });
  await expect.poll(() => frames.some((frame) => frame.header.codec === "h264")).toBe(true);
  expect(frames.some((frame) => frame.header.width === 600)).toBe(false);
  // An animation: about 20 Mbit/s for two seconds, where 8 Mbit/s fit a quiet screen.
  for (let tenth = 0; tenth < 20; tenth++) {
    sim.delta(tenth, 250_000);
    clock += 100;
    await expect.poll(() => frames.length).toBeGreaterThan(tenth);
  }
  sim.delta(99, 2);
  await expect
    .poll(() => frames.some((frame) => frame.header.width === 600 && frame.header.keyframe))
    .toBe(true);
});

it("a re-encoded picture keeps the time serve-sim's picture arrived, not the time the transcoder finished", async () => {
  let clock = 1000;
  const { capture, frames, sim, log } = await transcodingCapture(() => clock, 300);
  const video = { codec: "h264" as const, maxWidth: 1440, maxHeight: 2880, fps: 60 };
  await capture.configure?.({ ...video, bitrate: 2_000_000 });
  await capture.keyframe?.();
  await expect.poll(() => frames.some((frame) => frame.header.width === 600)).toBe(true);
  const sent = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
  const before = await sent();
  clock = 5000;
  sim.delta(7, 2);
  await expect.poll(sent).toBeGreaterThan(before);
  // The transcoder takes its time: the clock has moved on when the picture comes out.
  clock = 9000;
  await expect.poll(() => frames.at(-1)?.header.timestamp).toBe(5000);
});
