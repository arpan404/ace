import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { FrameDecoder, Recording, type RecordingArtifact } from "./index.ts";
import { deferred, frame } from "./testing/support.ts";
it("recordings stream the first and latest queued frame, publish an artifact and keep files private", async () => {
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
    expect(sequences).toEqual([1, 3]);
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
