import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { framePacket, type Frame } from "@ace/screen";
import { RecordingFeed } from "./recording-feed.ts";
import { jpegDimensions } from "./jpeg.ts";

/**
 * A stand-in ffmpeg decoder: one JPEG out per chunk of H.264 in, sized to the box its scale
 * filter names (2000 × 4000 without one), and it exits when its input closes or it is killed.
 */
const decoder = `const filter=process.argv[process.argv.indexOf("-vf")+1]??"";
const box=/min\\((\\d+),iw\\)':'min\\((\\d+),ih\\)/.exec(filter);
const width=box?Number(box[1]):2000,height=box?Number(box[2]):4000;
const image=Buffer.from([255,216,255,192,0,8,8,height>>8,height&255,width>>8,width&255,1,255,217]);
process.stdin.on("data",()=>process.stdout.write(image));
process.stdin.on("end",()=>process.exit(0));`;

function frame(
  sequence: number,
  codec: "jpeg" | "h264",
  options: { keyframe?: boolean; timestamp?: number } = {},
): Frame {
  const payload = Buffer.from(`${codec}-${sequence}`);
  const header = {
    version: 1 as const,
    sessionId: "capture-1",
    sequence,
    timestamp: options.timestamp ?? sequence,
    width: 1206,
    height: 2622,
    scale: 3,
    codec,
    ...(codec === "h264" ? { keyframe: options.keyframe ?? false } : {}),
    bytes: payload.length,
  };
  return { header, payload, packet: framePacket(header, payload) };
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-recording-feed-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const ffmpeg = join(home, "ffmpeg");
  await writeFile(ffmpeg, `#!${process.execPath}\n${decoder}\n`);
  await chmod(ffmpeg, 0o700);
  const written: Frame[] = [];
  const failures: unknown[] = [];
  let keyframes = 0;
  let now = 100;
  const feed = new RecordingFeed({
    streamId: "capture-1",
    ffmpeg,
    runtime: { spawn: spawnRawSupervised, now: () => now },
    env: {},
    write: (recorded) => written.push(recorded),
    keyframe: () => keyframes++,
    failure: (error) => failures.push(error),
  });
  onTestFinished(() => feed.stop());
  return {
    feed,
    written,
    failures,
    keyframes: () => keyframes,
    at(time: number) {
      now = time;
    },
  };
}

it("a watched device's video is recorded as JPEG within the recording's budget, in order after earlier stills", async () => {
  const f = await setup();
  f.feed.push(frame(7, "jpeg", { timestamp: 50 }));
  f.at(200);
  f.feed.push(frame(8, "h264", { keyframe: true }));
  await expect.poll(() => f.written.length).toBe(2);
  f.feed.push(frame(9, "h264"));
  await expect.poll(() => f.written.length).toBe(3);

  expect(f.written.map((recorded) => recorded.header.codec)).toEqual(["jpeg", "jpeg", "jpeg"]);
  expect(f.written[0]?.payload.toString()).toBe("jpeg-7");
  const decoded = f.written.slice(1).map((recorded) => jpegDimensions(recorded.payload));
  expect(decoded).toEqual([
    { width: 1280, height: 720 },
    { width: 1280, height: 720 },
  ]);
  expect(
    f.written.map((recorded) => ({
      sessionId: recorded.header.sessionId,
      sequence: recorded.header.sequence,
      timestamp: recorded.header.timestamp,
    })),
  ).toEqual([
    { sessionId: "capture-1", sequence: 0, timestamp: 50 },
    { sessionId: "capture-1", sequence: 1, timestamp: 200 },
    { sessionId: "capture-1", sequence: 2, timestamp: 200 },
  ]);
  // The decoded picture keeps pixels-per-point in step with its smaller size.
  expect(f.written[1]?.header.scale).toBeCloseTo((3 * 1280) / 1206);
  expect(f.failures).toEqual([]);
});

it("video joined mid-stream waits for a keyframe, asking the capture for one", async () => {
  const f = await setup();
  f.feed.push(frame(1, "h264"));
  f.feed.push(frame(2, "h264"));
  expect(f.keyframes()).toBe(2);
  f.feed.push(frame(3, "h264", { keyframe: true }));
  await expect.poll(() => f.written.length).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.written).toHaveLength(1);
});

it("without ffmpeg a watched device records nothing rather than failing the recording", async () => {
  const written: Frame[] = [];
  const failures: unknown[] = [];
  const feed = new RecordingFeed({
    streamId: "capture-1",
    ffmpeg: undefined,
    runtime: { spawn: spawnRawSupervised, now: () => 0 },
    env: {},
    write: (recorded) => written.push(recorded),
    keyframe: () => {},
    failure: (error) => failures.push(error),
  });
  feed.push(frame(1, "h264", { keyframe: true }));
  feed.push(frame(2, "jpeg"));
  feed.stop();
  feed.push(frame(3, "jpeg"));
  expect(written.map((recorded) => recorded.payload.toString())).toEqual(["jpeg-2"]);
  expect(failures).toEqual([]);
});
