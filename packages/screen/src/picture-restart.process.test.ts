/*
 * A JPEG-only screen's video after ace-media dies, against the real binary (X2): its pictures go
 * to a new ace-media on a new ingest connection, are encoded there and come back as the
 * session's H.264. What the adapter tests can't show (they hand back egress as soon as the
 * source holds a token) is the whole way round through a real restart: supervisor, reopened
 * source, new ingest, the encoder and egress. The first keyframe the new process encodes is
 * decoded by ace-media itself (a still of it, through its H.264 decoder), and kill → that
 * keyframe is measured over twenty restarts. Runs when ACE_MEDIA_TEST_BINARY names a built
 * ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { IngestWriter } from "@ace/media/ingest-writer";
import type { IngestProducer } from "@ace/media/ingest-sources";
import { MediaRuntime } from "@ace/media/runtime";
import type { MediaStill } from "@ace/media/stills";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { FrameDecoder, framePacket, type Frame } from "./frames.ts";
import { ScreenPictureSource } from "./picture-source.ts";

const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;
const jpeg = readFileSync(new URL("./testing/phone-screen.jpg", import.meta.url));

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The helper's still: a real 390×844 phone screen. */
function still(sequence: number): Frame {
  const frames: Frame[] = [];
  new FrameDecoder((frame) => void frames.push(frame)).push(
    framePacket(
      {
        version: 2,
        sessionId: "s1",
        seq: sequence,
        ts: sequence,
        width: 390,
        height: 844,
        scale: 1,
        codec: "jpeg",
        bytes: jpeg.length,
      },
      jpeg,
    ),
  );
  const [frame] = frames;
  if (!frame) throw new Error("no frame");
  return frame;
}

/**
 * ace-media's decode of an H.264 keyframe: a second source streams it in, and a still of that
 * source comes back only if ace-media's decoder made a picture of it.
 */
async function decoded(runtime: MediaRuntime, keyframe: Frame): Promise<MediaStill> {
  let writer: IngestWriter | undefined;
  const producer: IngestProducer = {
    source: "decode",
    kind: "screen",
    origin: { kind: "screen", platform: "windows" },
    sessionId: "decode",
    epoch: () => 1,
    consumers: { deliver: () => {} },
    keyframe: () => {},
    point: (address) => {
      writer?.close();
      writer = undefined;
      if (!address) return Promise.resolve();
      writer = new IngestWriter({
        socket: address.socket,
        token: address.token,
        onClosed: () => {},
        onKeyframe: () => {},
      });
      writer.write({
        kind: 1,
        flags: 1,
        ageUs: 0,
        width: keyframe.header.width,
        height: keyframe.header.height,
        displayWidth: keyframe.header.width,
        displayHeight: keyframe.header.height,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 1,
        codecString: keyframe.header.videoCodec ?? "avc1.42E033",
        description: new Uint8Array(0),
        extension: new Uint8Array(0),
        payload: keyframe.payload,
      });
      return Promise.resolve();
    },
  };
  const source = runtime.sources.add(producer);
  try {
    let path: string | undefined;
    await until(
      () =>
        (path = runtime.sources.live().find((l) => l.producer === producer)?.path) !== undefined,
    );
    // The unit is in once ace-media has it as the source's still.
    for (let tries = 0; ; tries++) {
      const made = await runtime.stills.take(
        {
          source: path ?? "",
          maxWidth: 390,
          maxHeight: 844,
          maxPixels: 390 * 844,
          quality: 80,
          deadlineMs: 2_000,
        },
        () => Promise.resolve(undefined),
        (taken) => taken,
      );
      if (made) return made;
      if (tries > 50) throw new Error("ace-media made no still of the keyframe");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    writer?.close();
    source.close();
  }
}

/**
 * One round: a healthy ace-media encoding the session, killed; ms until the new one's first
 * keyframe, and that keyframe.
 */
async function round(): Promise<{
  ms: number;
  keyframe: Frame;
  runtime: MediaRuntime;
  done: () => void;
}> {
  if (!binary) throw new Error("no ace-media binary");
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-x2-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ encode: "auto", delivery: "auto", recordings: "auto", stills: "auto" }),
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `id-${++ids}`,
    capabilities: { ingest: ["screen-pictures", "screen"], delivery: true },
    log: () => {},
  });
  /** Each keyframe off egress: when it came, and which ace-media process was running then. */
  const keyframes: { at: number; pid: number | undefined; frame: Frame }[] = [];
  const source = new ScreenPictureSource({
    sessionId: "s1",
    platform: "windows",
    helper: {
      capabilities: undefined,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      requestV2: async () => ({}),
      request: async () => ({ codec: "jpeg" }),
    },
    media: { add: (producer) => runtime.sources.add(producer) },
    accept: (frame) => {
      if (frame.header.codec === "h264" && frame.header.keyframe)
        keyframes.push({
          at: performance.now(),
          pid: runtime.supervisor.snapshot().pid,
          frame,
        });
    },
    now: () => performance.now(),
  });
  // The helper's pictures at 30 fps, whatever ace-media is doing.
  let sequence = 0;
  const helper = setInterval(() => source.daemonFrame(still(++sequence)), 33);
  const done = () => {
    clearInterval(helper);
    source.close();
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  };
  try {
    await source.configure({
      codec: "h264",
      maxWidth: 390,
      maxHeight: 844,
      fps: 30,
      bitrate: 2_000_000,
    });
    await until(() => keyframes.length > 0);
    const pid = runtime.supervisor.snapshot().pid;
    if (!pid) throw new Error("no ace-media process");
    const killed = performance.now();
    process.kill(pid, "SIGKILL");
    // Only a keyframe the new process encoded counts.
    const fresh = () =>
      keyframes.find((k) => k.at > killed && k.pid !== undefined && k.pid !== pid);
    await until(() => fresh() !== undefined, 10_000);
    const first = fresh();
    if (!first) throw new Error("no keyframe from the new process");
    return { ms: first.at - killed, keyframe: first.frame, runtime, done };
  } catch (error) {
    done();
    throw error;
  }
}

it.skipIf(!binary)(
  "after ace-media is killed, a JPEG-only screen's video comes back from the new process as H.264 that decodes",
  async () => {
    const { keyframe, runtime, done } = await round();
    try {
      const picture = await decoded(runtime, keyframe);
      expect({ width: picture.width, height: picture.height }).toEqual({ width: 390, height: 844 });
      expect(picture.steps.map((s) => s.step)).toContain("decode");
    } finally {
      done();
    }
  },
  60_000,
);

it.skipIf(!binary)(
  "after ace-media is killed, a JPEG-only screen's video is back from the new process within 2 s, p95 of twenty restarts",
  async () => {
    const took: number[] = [];
    // A fresh runtime each round: repeated kills of one process back off on purpose.
    for (let n = 0; n < 20; n++) {
      const { ms, done } = await round();
      done();
      took.push(ms);
    }
    const p95 = took.toSorted((a, b) => a - b)[Math.ceil(took.length * 0.95) - 1] ?? Infinity;
    const load = loadavg()[0] ?? 0;
    const cores = availableParallelism();
    // The benches' rule: above twice the cores in load, the number is reported, not enforced.
    const enforced = load <= 2 * cores;
    console.info(
      `kill → new keyframe p95 ${Math.round(p95)} ms of ${JSON.stringify(took.map(Math.round))} at load ${load.toFixed(1)} on ${cores} cores${enforced ? "" : " (not enforced)"}`,
    );
    if (enforced) expect(p95, JSON.stringify(took.map(Math.round))).toBeLessThan(2_000);
  },
  120_000,
);
