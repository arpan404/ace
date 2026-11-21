/*
 * Screen recordings through the real ace-media (X1). An H.264 screen's recording tees the
 * helper's real VideoToolbox H.264 (the committed fixture) into ace-media's recorder; a JPEG-only
 * screen's recording goes through the manager with a fake helper sending a real JPEG, which
 * ace-media encodes with nobody watching. Each comes out as MP4 parts. Runs when
 * ACE_MEDIA_TEST_BINARY names a built ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { FakeMediaRecorder } from "@ace/media/testing/fake-recorder";
import { defaultMediaSettings, nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { FrameDecoder, type Frame } from "./frames.ts";
import { ScreenRecording, type RecordingArtifact } from "./recording.ts";
import { helperFixture } from "./testing/support.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function runtime() {
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-"));
  let next = 0;
  const media = new MediaRuntime({
    version: execFileSync(binary ?? "", ["--version"])
      .toString()
      .trim(),
    binary: binary ?? "",
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => defaultMediaSettings,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `r${++next}`,
    log: () => {},
  });
  cleanups.push(() => {
    media.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { media, directory: join(runtimeDir, "recording") };
}

/** The video samples an MP4 part holds, from its moof/trun boxes (ISO/IEC 14496-12). */
function samples(path: string): number {
  const file = readFileSync(path);
  expect(file.toString("latin1", 4, 8)).toBe("ftyp");
  let count = 0;
  for (let at = 0; at + 8 <= file.length;) {
    const size = file.readUInt32BE(at);
    if (size < 8) break;
    if (file.toString("latin1", at + 4, at + 8) === "moof") {
      const trun = file.indexOf("trun", at, "latin1");
      if (trun > 0 && trun < at + size) count += file.readUInt32BE(trun + 8);
    }
    at += size;
  }
  return count;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.runIf(binary)(
  "an H.264 screen's recording holds the helper's frames as MP4 parts",
  async () => {
    const frames: Frame[] = [];
    const decoder = new FrameDecoder((frame) => frames.push(frame));
    decoder.push(
      readFileSync(new URL("./testing/fixtures/h264-deltas.ace-screen", import.meta.url)),
    );
    decoder.end();
    const { media, directory } = runtime();
    const started = await media.recordings.start({
      origin: { kind: "screen", platform: "macos" },
      directory,
      maxBytes: 1 << 20,
      private: () => false,
    });
    if (!started.ok) throw new Error(started.reason);
    const published: RecordingArtifact[] = [];
    const recording = new ScreenRecording({
      id: "screen-recording",
      directory,
      recording: started.recording,
      pictures: false,
      publish: async (artifact) => void published.push(artifact),
    });
    for (const frame of frames) {
      recording.push(frame);
      await sleep(30);
    }
    const artifact = await recording.stop();
    expect(published).toEqual([artifact]);
    expect(artifact.mimeType).toBe("video/mp4");
    const written = artifact.parts.reduce((sum, part) => sum + samples(part.path), 0);
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(frames.length);
  },
  60_000,
);

it.runIf(binary)(
  "a JPEG-only screen's recording is encoded by ace-media with nobody watching",
  async () => {
    const { media } = runtime();
    const published: RecordingArtifact[] = [];
    const jpeg = fileURLToPath(new URL("./testing/phone-screen.jpg", import.meta.url));
    const f = await helperFixture("win32", {
      env: { MODEL_IMAGE_FILE: jpeg, MODEL_FRAME_WIDTH: "390", MODEL_FRAME_HEIGHT: "844" },
      recorder: media.recordings,
      publishArtifact: async (artifact) => void published.push(artifact),
    });
    cleanups.push(() => f.close());
    const session = await f.start();
    await f.manager.startRecording(session.sessionId);
    // The helper sends a picture whenever the screen is asked for.
    for (let shot = 0; shot < 30; shot++) {
      await f.manager.captureScreenshot(session.sessionId).catch(() => {});
      await sleep(60);
    }
    const artifact = await f.manager.stopRecording(session.sessionId);
    expect(published).toEqual([artifact]);
    expect(artifact.parts.reduce((sum, part) => sum + samples(part.path), 0)).toBeGreaterThan(0);
  },
  90_000,
);

it("refuses to record, saying why, while ace-media can't record", async () => {
  const recorder = new FakeMediaRecorder();
  recorder.refuse = "ace-media isn't available to record: it keeps failing";
  const f = await helperFixture("win32", { recorder });
  cleanups.push(() => f.close());
  const session = await f.start();
  await expect(f.manager.startRecording(session.sessionId)).rejects.toThrow(
    "ace-media isn't available to record: it keeps failing",
  );
  await expect(f.manager.stopRecording(session.sessionId)).rejects.toThrow("No recording active");
});
