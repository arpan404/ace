import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { FrameDecoder, Recording, type RecordingArtifact } from "./index.ts";
import { type Frame } from "./frames.ts";
import { deferred, frame as testFrame } from "./testing/support.ts";
it("recordings stream every queued frame through stop, publish an artifact and keep files private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-recording-"));
  const published: RecordingArtifact[] = [];
  try {
    const recorder = await Recording.open(directory, "recording", async (artifact) => {
      published.push(artifact);
    });
    recorder.push(testFrame(1));
    recorder.push(testFrame(2));
    recorder.push(testFrame(3));
    const artifact = await recorder.stop();
    const bytes = await readFile(artifact.path);
    const sequences: number[] = [];
    const decoder = new FrameDecoder((value) => sequences.push(value.header.sequence));
    decoder.push(bytes);
    decoder.end();
    expect(sequences).toEqual([1, 2, 3]);
    expect(artifact.bytes).toBe(bytes.length);
    expect(published).toEqual([artifact]);
    expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    expect(await recorder.stop()).toEqual(artifact);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("recording byte limits finish with complete packets and stop accepting more frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-recording-"));
  try {
    const recorder = await Recording.open(
      directory,
      "capped",
      async () => {},
      testFrame(1).packet.length,
    );
    recorder.push(testFrame(1));
    recorder.push(testFrame(2));
    const artifact = await recorder.stop();
    recorder.push(testFrame(3));
    expect(await readFile(artifact.path)).toEqual(testFrame(1).packet);
    expect(artifact.bytes).toBe(testFrame(1).packet.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("recording quota releases capture before a stalled artifact publisher completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-recording-"));
  const publishing = deferred<void>(),
    release = deferred<void>();
  let captureReleased = false;
  const recorder = await Recording.open(
    directory,
    "quota",
    async () => {
      publishing.resolve();
      await release.promise;
    },
    testFrame(1).packet.length,
    () => {
      captureReleased = true;
    },
  );
  try {
    recorder.push(testFrame(1));
    recorder.push(testFrame(2));
    await publishing.promise;
    expect(captureReleased).toBe(true);
  } finally {
    release.resolve();
  }
  try {
    const artifact = await recorder.stop();
    expect(await readFile(artifact.path)).toEqual(testFrame(1).packet);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const run = promisify(execFile);
it.skipIf(process.platform !== "darwin")(
  "every real H.264 access unit admitted during an outstanding write decodes after stop",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "screen-recording-codec-"));
    try {
      const frames: Frame[] = [];
      const decoder = new FrameDecoder((frame) => frames.push(frame));
      decoder.push(
        await readFile(new URL("./testing/fixtures/h264-deltas.ace-screen", import.meta.url)),
      );
      decoder.end();
      expect(frames).toHaveLength(12);
      expect(frames.filter((frame) => frame.header.keyframe)).toHaveLength(1);
      const recorder = await Recording.open(directory, "codec", async () => {});
      // No await between pushes: every delta arrives while the first fs write is outstanding.
      for (const frame of frames) recorder.push(frame);
      const artifact = await recorder.stop();
      const { stdout } = await run("swift", [
        new URL("./testing/decode-recording.swift", import.meta.url).pathname,
        artifact.path,
      ]);
      expect(Number(stdout.trim())).toBe(frames.length);
      expect(artifact.gaps).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
