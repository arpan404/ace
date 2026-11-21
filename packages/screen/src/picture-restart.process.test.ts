/*
 * A JPEG-only screen's video after ace-media dies, against the real binary (X2): its pictures go
 * to a new ace-media on a new ingest connection, are encoded there and come back as the
 * session's H.264. What the adapter tests can't show (they hand back egress as soon as the
 * source holds a token) is the whole way round through a real restart: supervisor, reopened
 * source, new ingest, the encoder and egress. Measured from the kill to the first keyframe the
 * new process encodes, p95 of five restarts. Runs when ACE_MEDIA_TEST_BINARY names a built
 * ace-media (`bun run check:media` does).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
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

/** NAL unit types in an Annex B access unit. */
function nalTypes(payload: Uint8Array): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < payload.length; i++)
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1)
      types.push((payload[i + 3] ?? 0) & 0x1f);
  return types;
}

/** One round: a healthy ace-media encoding the session, killed; ms until the new one's keyframe. */
async function round(): Promise<number> {
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
    capabilities: { ingest: ["screen-pictures"], delivery: true },
    log: () => {},
  });
  /** Each keyframe off egress: when it came, and which ace-media process was running then. */
  const keyframes: { at: number; pid: number | undefined; nals: number[] }[] = [];
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
          nals: nalTypes(frame.payload),
        });
    },
    now: () => performance.now(),
  });
  // The helper's pictures at 30 fps, whatever ace-media is doing.
  let sequence = 0;
  const helper = setInterval(() => source.daemonFrame(still(++sequence)), 33);
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
    // Only a keyframe the new process encoded counts, and only a decodable one.
    const fresh = () =>
      keyframes.find((k) => k.at > killed && k.pid !== undefined && k.pid !== pid);
    await until(() => fresh() !== undefined, 10_000);
    const first = fresh();
    expect(first?.nals).toEqual(expect.arrayContaining([7, 8, 5]));
    return (first?.at ?? Infinity) - killed;
  } finally {
    clearInterval(helper);
    source.close();
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

it.skipIf(!binary)(
  "after ace-media is killed, a JPEG-only screen's video is back from the new process within 2 s, p95 of five restarts",
  async () => {
    const took: number[] = [];
    // A fresh runtime each round: repeated kills of one process back off on purpose.
    for (let n = 0; n < 5; n++) took.push(await round());
    const p95 = took.toSorted((a, b) => a - b)[Math.ceil(took.length * 0.95) - 1] ?? Infinity;
    const load = loadavg()[0] ?? 0;
    // Like the benches: on a machine this loaded the number is reported, not enforced.
    console.info(
      `kill → new keyframe ${JSON.stringify(took.map(Math.round))} ms at load ${Math.round(load)}`,
    );
    expect(p95, JSON.stringify(took.map(Math.round))).toBeLessThan(load >= 24 ? 10_000 : 2_000);
  },
  90_000,
);
