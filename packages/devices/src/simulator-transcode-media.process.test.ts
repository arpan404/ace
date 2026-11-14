/*
 * A Simulator re-encoded by ace-media for a small viewer (E3b, the `--transcode` replacement),
 * against the real binary and VideoToolbox: serve-sim's real H.264 (made here with ffmpeg at a
 * Simulator's 1206x2622) is read by ace-media, decoded at the viewer's size and encoded again,
 * and the capture publishes the smaller stream. What only this shows: the daemon asking for the
 * encode, VideoToolbox doing it inside ace-media, and the source reporting it on hardware with
 * no CPU copy. Runs on macOS with ffmpeg on PATH when ACE_MEDIA_TEST_BINARY names a binary.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import type { FromMedia } from "@ace/media/wire";
import { nodeMediaHost, systemMediaClock, type MediaSettings } from "@ace/media/supervisor";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Frame } from "@ace/screen";
import { DevicePlatform, startCapture, type DeviceRuntime } from "./index.ts";
import { fakeServeSim } from "./testing/fake-serve-sim.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const udid = "11111111-1111-4111-8111-111111111111";

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const length16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);

/** A Simulator-sized H.264 stream as serve-sim's records: avcC, then access units. */
function simulatorStream() {
  const annexB = execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1206x2622:rate=30",
      "-frames:v",
      "60",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-x264-params",
      "keyint=60:bframes=0:aud=1:slices=1",
      "-f",
      "h264",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const nals: Buffer[] = [];
  let start = -1;
  for (let index = 0; index + 3 < annexB.length; index++)
    if (annexB[index] === 0 && annexB[index + 1] === 0 && annexB[index + 2] === 1) {
      if (start >= 0) nals.push(annexB.subarray(start, index - (annexB[index - 1] === 0 ? 1 : 0)));
      start = index + 3;
    }
  nals.push(annexB.subarray(start));
  const sps = nals.find((nal) => ((nal[0] ?? 0) & 31) === 7);
  const pps = nals.find((nal) => ((nal[0] ?? 0) & 31) === 8);
  if (!sps || !pps) throw new Error("no parameter sets");
  const description = Buffer.concat([
    Buffer.from([1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 0xff, 0xe1]),
    length16(sps.length),
    sps,
    Buffer.from([1]),
    length16(pps.length),
    pps,
  ]);
  // Access units start at each delimiter (type 9); their slices go length-prefixed.
  const units: { key: boolean; body: Buffer }[] = [];
  for (const nal of nals) {
    const type = (nal[0] ?? 0) & 31;
    if (type === 9) units.push({ key: false, body: Buffer.alloc(0) });
    if (type !== 1 && type !== 5) continue;
    const current = units.at(-1);
    if (!current) continue;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(nal.length);
    current.body = Buffer.concat([current.body, length, nal]);
    if (type === 5) current.key = true;
  }
  return { description, units: units.filter((unit) => unit.body.length > 0) };
}

const runtime: DeviceRuntime = {
  now: () => performance.now(),
  id: () => "native",
  spawn: spawnRawSupervised,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

it.runIf(process.platform === "darwin" && ffmpeg && !!binary)(
  "a viewer too small for the Simulator gets ace-media's VideoToolbox re-encode at its size, on hardware with no CPU copy",
  { timeout: 120_000 },
  async () => {
    const stream = simulatorStream();
    const [first, ...rest] = stream.units;
    if (!first?.key) throw new Error("the stream starts at a keyframe");
    const home = await mkdtemp(join(tmpdir(), "ace-e3b-transcode-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const sim = await fakeServeSim(home, "0.1.49-beta.139.1", udid, {
      stream: { description: stream.description, key: first.body },
    });
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
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "legacy",
      recordings: "legacy",
      stills: "legacy",
    };
    const statuses: Extract<FromMedia, { type: "source.status" }>[] = [];
    const media = new MediaRuntime({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir: home,
      dataDir: home,
      settings: () => settings,
      host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
      clock: systemMediaClock,
      random: Math.random,
      randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      id: randomUUID,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      log: () => {},
      onMessage: (message) => {
        if (message.type === "source.status") statuses.push(message);
      },
      capabilities: { ingest: ["simulator"], recordings: false, stills: false, delivery: false },
    });
    onTestFinished(() => media.dispose());
    const published: Frame[] = [];
    const capture = await startCapture({
      device: { id: `ios:${udid}`, name: "iPhone", platform: "ios", state: "booted" },
      streamId: "native",
      fps: 30,
      platform,
      runtime,
      env: { PATH: home },
      publish: (frame) => void published.push(frame),
      failure: () => {},
      media: { attach: (producer) => media.sources.add(producer) },
    });
    onTestFinished(() => capture.stop());
    // serve-sim keeps sending its stream, looping the clip from its keyframe.
    let next = 0;
    const timer = setInterval(() => {
      const unit = rest[next++ % rest.length];
      if (unit) sim.send(unit.key ? 2 : 3, unit.body);
    }, 33);
    onTestFinished(() => clearInterval(timer));
    expect(
      await capture.configure?.({
        codec: "h264",
        maxWidth: 800,
        maxHeight: 1280,
        fps: 60,
        bitrate: 3_000_000,
      }),
    ).toEqual({ codec: "h264" });

    const resized = () =>
      published.filter((frame) => frame.header.codec === "h264" && frame.header.height === 1280);
    await until(() => resized().length >= 10);
    const key = resized().find((frame) => frame.header.keyframe);
    expect(key?.header).toMatchObject({ codec: "h264", keyframe: true, width: 588, height: 1280 });
    expect(key?.header.videoCodec).toMatch(/^avc1\./);
    expect(key?.header.scale).toBeCloseTo(588 / 1206, 5);
    expect(key?.payload.subarray(0, 4).toString("hex")).toBe("00000001");
    // ace-media says how it ran: VideoToolbox decode, scale and encode, no picture copied.
    const steps = statuses.findLast((status) => status.acceleration)?.acceleration?.steps ?? [];
    expect(steps.map((step) => [step.step, step.backend])).toEqual([
      ["decode", "vt"],
      ["scale", "vt"],
      ["encode", "vt"],
    ]);
    if (process.arch === "arm64") expect(steps.every((step) => step.hardware)).toBe(true);
    expect(steps.every((step) => step.readbacks === 0 && step.uploads === 0)).toBe(true);
  },
);
