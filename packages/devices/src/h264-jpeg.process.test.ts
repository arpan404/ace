import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { findExecutable } from "@ace/provider-kit/discovery";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { H264Jpeg } from "./h264-jpeg.ts";

const run = promisify(execFile);
const ffmpeg = await findExecutable("ffmpeg", process.env);

/** A real H.264 clip, one access unit per picture with a delimiter in front, as a device sends. */
async function clip(frames: number): Promise<Buffer[] | undefined> {
  if (!ffmpeg) return undefined;
  const home = await mkdtemp(join(tmpdir(), "h264-jpeg-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "clip.h264");
  try {
    await run(ffmpeg, [
      ...["-nostdin", "-loglevel", "error", "-f", "lavfi"],
      ...["-i", "testsrc=size=640x360:rate=30", "-frames:v", String(frames)],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0"],
      ...["-x264-params", "aud=1", "-f", "h264", file],
    ]);
  } catch {
    return undefined;
  }
  const bytes = await readFile(file);
  const delimiter = Buffer.from([0, 0, 0, 1, 9]);
  const starts: number[] = [];
  for (let at = bytes.indexOf(delimiter); at >= 0; at = bytes.indexOf(delimiter, at + 1))
    starts.push(at);
  return starts.map((start, index) => bytes.subarray(start, starts[index + 1]));
}

it("every picture a device sent comes out as a still while no further picture comes", async (context) => {
  const units = await clip(30);
  if (!ffmpeg || !units) return context.skip("needs ffmpeg with libx264");
  expect(units).toHaveLength(30);
  let images = 0;
  const decoder = new H264Jpeg({
    ffmpeg,
    runtime: { spawn: spawnRawSupervised },
    env: process.env,
    image: () => images++,
    failure: (error) => {
      throw error;
    },
  });
  onTestFinished(() => decoder.stop());
  units.forEach((payload, index) => decoder.push({ payload, keyframe: index === 0 }));
  // The screen goes still: no more units, and ffmpeg's input stays open.
  await expect.poll(() => images, { timeout: 5000 }).toBe(30);
});
