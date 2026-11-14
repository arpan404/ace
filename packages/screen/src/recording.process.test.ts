import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { FrameDecoder, Recording, type RecordingArtifact } from "./index.ts";
import { framePacket, type Frame } from "./frames.ts";
import { deferred, frame } from "./testing/support.ts";
it("recordings stream every queued frame through stop, publish an artifact and keep files private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-recording-"));
  const published: RecordingArtifact[] = [];
  try {
    const recorder = await Recording.open(directory, "recording", async (artifact) => {
      published.push(artifact);
    });
    recorder.push(frame(1));
    recorder.push(frame(2));
    recorder.push(frame(3));
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
      frame(1).packet.length,
    );
    recorder.push(frame(1));
    recorder.push(frame(2));
    const artifact = await recorder.stop();
    recorder.push(frame(3));
    expect(await readFile(artifact.path)).toEqual(frame(1).packet);
    expect(artifact.bytes).toBe(frame(1).packet.length);
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
    frame(1).packet.length,
    () => {
      captureReleased = true;
    },
  );
  try {
    recorder.push(frame(1));
    recorder.push(frame(2));
    await publishing.promise;
    expect(captureReleased).toBe(true);
  } finally {
    release.resolve();
  }
  try {
    const artifact = await recorder.stop();
    expect(await readFile(artifact.path)).toEqual(frame(1).packet);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const h264 = (sequence: number, keyframe = false): Frame => {
  const source = frame(sequence);
  const header = { ...source.header, codec: "h264" as const, keyframe };
  return { header, payload: source.payload, packet: framePacket(header, source.payload) };
};

it("overflow omits the dependent deltas through the next keyframe and records the gap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-recording-"));
  try {
    const recorder = await Recording.open(
      directory,
      "overflow",
      async () => {},
      50 * 1024 * 1024,
      () => {},
      h264(2).packet.length,
    );
    recorder.push(h264(1, true));
    recorder.push(h264(2));
    recorder.push(h264(3)); // queue is full
    await new Promise((resolve) => setTimeout(resolve, 20));
    recorder.push(h264(4)); // space returned, but this delta depends on 3
    recorder.push(h264(5, true));
    recorder.push(h264(6));
    const artifact = await recorder.stop();
    const sequences: number[] = [];
    const decoder = new FrameDecoder((value) => sequences.push(value.header.sequence));
    decoder.push(await readFile(artifact.path));
    decoder.end();
    expect(sequences).toEqual([1, 2, 5, 6]);
    expect(artifact.gaps).toEqual([{ first: 3, last: 4 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
