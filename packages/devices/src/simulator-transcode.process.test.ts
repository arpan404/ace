import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { nodeBinary } from "@ace/provider-kit/testing";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { simulatorNeedsTranscode } from "./simulator-transcode.ts";
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

/** The screen helper's `--transcode` mode, played by a script: half-size H.264 per frame in. */
const fakeTranscoder = (log: string) => `
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
    process.stdout.write(Buffer.concat([size, out, payload]));
    first = false;
  }
});
`;

it("serve-sim's stream passes through for a good link and is re-encoded smaller for a thin one", async () => {
  const home = await mkdtemp(join(tmpdir(), "sim-transcode-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "transcoder"));
  const log = join(home, "transcoder.log");
  const transcoder = await nodeBinary(join(home, "transcoder"), "transcode", fakeTranscoder(log));
  await fakeServeSim(home, "0.1.48", udid);
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
    now: () => 1000,
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
