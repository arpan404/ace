import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MediaRuntime } from "./runtime.ts";
import {
  defaultMediaSettings,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
} from "./supervisor.ts";

// The daemon's recordings against the real ace-media (`bun run check:media` builds it and sets
// ACE_MEDIA_TEST_BINARY), through `MediaRuntime.recordings`, the path every recorder takes since
// X1: a tee'd H.264 source stamped at read time, the 100 ms epochs and their decisions, the
// source going private and public, and ace-media killed mid-recording. Unit tests can't show the
// parts that come out the other end.
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const fixture = readFileSync(
  new URL("../../../native/media/crates/media-mp4/tests/vectors/h264.bin", import.meta.url),
);
const configLength = fixture.readUInt32BE(0);
const avcc = fixture.subarray(4, 4 + configLength);
const pictures: Buffer[] = [];
for (let at = 4 + configLength; at < fixture.length;) {
  const length = fixture.readUInt32BE(at);
  pictures.push(fixture.subarray(at + 4, at + 4 + length));
  at += 4 + length;
}
const uuid = Buffer.from("ace-media-test-1");

/** A VideoToolbox IDR tagged with `id` in an SEI its decoder ignores (H.264 D.1.6). */
function tagged(id: number): Uint8Array {
  const sei = Buffer.concat([
    Buffer.from([6, 5, 18]),
    uuid,
    Buffer.from([0xa0 | (id >> 8), id & 0xff, 0x80]),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(sei.length);
  return Buffer.concat([length, sei, pictures[id % pictures.length] ?? Buffer.alloc(0)]);
}

/** Video sample ids per part, read from the moof/trun/mdat layout (ISO/IEC 14496-12). */
function ids(path: string): number[] {
  const file = readFileSync(path);
  const boxes = (from: number, to: number) => {
    const out: { kind: string; at: number; size: number }[] = [];
    for (let at = from; at + 8 <= to;) {
      const size = file.readUInt32BE(at);
      if (size < 8 || at + size > to) break;
      out.push({ kind: file.toString("latin1", at + 4, at + 8), at, size });
      at += size;
    }
    return out;
  };
  const top = boxes(0, file.length);
  expect(top.slice(0, 2).map((b) => b.kind)).toEqual(["ftyp", "moov"]);
  const found: number[] = [];
  for (const moof of top.filter((b) => b.kind === "moof")) {
    for (const traf of boxes(moof.at + 8, moof.at + moof.size).filter((b) => b.kind === "traf")) {
      const children = boxes(traf.at + 8, traf.at + traf.size);
      const tfhd = children.find((b) => b.kind === "tfhd");
      const trun = children.find((b) => b.kind === "trun");
      if (!tfhd || !trun || file.readUInt32BE(tfhd.at + 12) !== 1) continue;
      const count = file.readUInt32BE(trun.at + 12);
      let data = moof.at + file.readInt32BE(trun.at + 16);
      for (let i = 0; i < count; i++) {
        const row = trun.at + 20 + i * 12;
        const size = file.readUInt32BE(row + 4);
        if (i === 0)
          expect(file.readUInt32BE(row + 8), "fragments start at keyframes").toBe(0x02000000);
        const sample = file.subarray(data, data + size);
        const at = sample.indexOf(uuid) + 16;
        found.push(((sample[at] ?? 0) & 0x0f) * 256 + (sample[at + 1] ?? 0));
        data += size;
      }
    }
  }
  return found;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRuntime(exits: MediaExit[] = []) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-rec-"));
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
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `r${++next}`,
    onExit: (exit) => void exits.push(exit),
    log: () => {},
  });
  cleanups.push(() => {
    media.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { media, directory: join(runtimeDir, "recording") };
}

const unit = (id: number, keyframe: boolean) =>
  ({
    kind: "video",
    keyframe,
    codec: 2,
    width: 64,
    height: 64,
    ...(keyframe ? { description: avcc } : {}),
    payload: tagged(id),
  }) as const;

/** Every sample once, in the order read: strictly increasing, so no unit was written twice. */
function strictlyIncreasing(written: number[]): void {
  for (let at = 1; at < written.length; at++)
    expect(written[at], `sample ${at} after ${written[at - 1]}`).toBeGreaterThan(
      written[at - 1] ?? -1,
    );
}

it.runIf(binary)(
  "records a tee'd source through the daemon's runtime: nothing private written, and a kill -9 continues in a new part",
  async () => {
    const exits: MediaExit[] = [];
    const { media: runtime, directory } = makeRuntime(exits);
    const supervisor = runtime.supervisor;
    let secret = false;

    // Nothing else needs ace-media: the recording starts it and waits for it.
    const start = await runtime.recordings.start({
      origin: { kind: "screen", platform: "macos" },
      directory,
      maxBytes: 1 << 20,
      private: () => secret,
      keyframe: () => {},
    });
    if (!start.ok) throw new Error(start.reason);
    const recording = start.recording;

    const privateIds = new Set<number>();
    let id = 0;
    const play = async (frames: number) => {
      for (let n = 0; n < frames; n++, id++) {
        if (secret) privateIds.add(id);
        recording.push(unit(id, n % 5 === 0));
        await sleep(20);
      }
    };
    const transition = (to: boolean) => {
      secret = to;
      recording.privacy();
    };

    await play(30);
    transition(true);
    await play(15);
    transition(false);
    await play(30);

    // Kill ace-media mid-recording; the supervisor restarts it and the runtime replays.
    const pid = supervisor.snapshot().pid ?? 0;
    process.kill(pid, "SIGKILL");
    await until(() => exits.length === 1);
    expect(exits[0]?.failure).toBe(true);
    expect(exits[0]?.recordings).toHaveLength(1);
    await until(() => supervisor.health() === "healthy" && supervisor.snapshot().pid !== pid);
    await until(() => recording.parts.some((p) => p.index === 0));
    await sleep(200);
    await play(30);
    transition(true);
    await play(10);
    transition(false);
    await play(30);

    const end = await recording.stop();
    expect(end.ok, JSON.stringify(end)).toBe(true);
    expect(end.parts.map((p) => p.index)).toEqual([0, 1]);
    const [before = [], after = []] = end.parts.map((p) => ids(p.path));
    const written = [...before, ...after];
    expect(
      written.filter((n) => privateIds.has(n)),
      "frames read while private",
    ).toEqual([]);
    // Most public frames survive: only the open group at the kill and frames read within
    // 100 ms of a resume (or before the first keyframe after one) may be missing.
    expect(written.length).toBeGreaterThan(80);
    // Part 1 starts after part 0 ends, and no sample appears twice, within or across parts.
    expect(before.length && after.length).toBeGreaterThan(0);
    strictlyIncreasing(written);
    expect(runtime.recordings.active).toBe(0);
  },
  60_000,
);

it.runIf(binary)(
  "a clip stopped before the first 100 ms epoch still holds its video",
  async () => {
    const { media: runtime, directory } = makeRuntime();
    const start = await runtime.recordings.start({
      origin: { kind: "screen", platform: "macos" },
      directory,
      maxBytes: 1 << 20,
      private: () => false,
      keyframe: () => {},
    });
    if (!start.ok) throw new Error(start.reason);
    for (let id = 0; id < 3; id++) start.recording.push(unit(id, id === 0));
    const end = await start.recording.stop();
    expect(end.ok, JSON.stringify(end)).toBe(true);
    expect(end.parts.flatMap((p) => ids(p.path))).toEqual([0, 1, 2]);
    // ace-media confirmed the barrier: nothing was left out.
    expect(end.ok && end.truncated).toBeUndefined();
  },
  30_000,
);

it.runIf(binary)(
  "a recording stopped while ace-media restarts after a crash keeps the part the crash cut",
  async () => {
    const exits: MediaExit[] = [];
    const { media: runtime, directory } = makeRuntime(exits);
    const start = await runtime.recordings.start({
      origin: { kind: "screen", platform: "macos" },
      directory,
      maxBytes: 1 << 20,
      private: () => false,
      keyframe: () => {},
    });
    if (!start.ok) throw new Error(start.reason);
    const recording = start.recording;
    for (let id = 0; id < 40; id++) {
      recording.push(unit(id, id % 5 === 0));
      await sleep(20);
    }
    // Part 0 is still open: the crash cuts it, and the person stops during the restart.
    expect(recording.parts).toEqual([]);
    const pid = runtime.supervisor.snapshot().pid ?? 0;
    process.kill(pid, "SIGKILL");
    await until(() => exits.length === 1);
    const end = await recording.stop();
    expect(end.ok, JSON.stringify(end)).toBe(true);
    expect(end.parts.map((p) => p.index)).toEqual([0]);
    // The crash took what followed the part's last whole fragment, and the end says so.
    expect(end.ok && end.truncated).toBe("final-epoch");
    const written = end.parts.flatMap((p) => ids(p.path));
    // Everything up to the last whole fragment before the kill.
    expect(written.length).toBeGreaterThan(20);
    strictlyIncreasing(written);
  },
  60_000,
);

const still = readFileSync(
  new URL("../../../packages/screen/src/testing/phone-screen.jpg", import.meta.url),
);

/** The video samples each part holds, from its moof/trun boxes (ISO/IEC 14496-12). */
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

it.runIf(binary)(
  "records JPEG pictures through ace-media's own encode with nobody watching, never while private",
  async () => {
    const exits: MediaExit[] = [];
    const { media: runtime, directory } = makeRuntime(exits);
    let secret = true;
    const start = await runtime.recordings.start({
      origin: { kind: "tab-pictures" },
      encode: { codec: "avc1.42E033", width: 390, height: 844, fps: 15, bitrate: 1_000_000 },
      directory,
      maxBytes: 1 << 20,
      private: () => secret,
    });
    if (!start.ok) throw new Error(start.reason);
    const recording = start.recording;
    const picture = {
      kind: "picture",
      keyframe: true,
      codec: 7,
      width: 390,
      height: 844,
      payload: still,
    } as const;
    const play = async (count: number) => {
      for (let n = 0; n < count; n++) {
        recording.push(picture);
        await sleep(60);
      }
    };
    // Private from the start: nothing of it may be written.
    await play(10);
    secret = false;
    recording.privacy();
    await play(60);
    // ace-media killed mid-recording: the recording continues in a new part.
    const pid = runtime.supervisor.snapshot().pid ?? 0;
    process.kill(pid, "SIGKILL");
    await until(() => exits.length === 1);
    await until(
      () => runtime.supervisor.health() === "healthy" && runtime.supervisor.snapshot().pid !== pid,
    );
    await sleep(300);
    await play(60);
    const end = await recording.stop();
    expect(end.ok, JSON.stringify(end)).toBe(true);
    expect(end.parts.length).toBeGreaterThanOrEqual(2);
    const written = end.parts.map((part) => samples(part.path));
    expect(
      written.every((count) => count > 0),
      JSON.stringify(written),
    ).toBe(true);
    // Each process saw 60 public pictures, the first ten private ones before them: at most the
    // public ones were written.
    expect(Math.max(...written)).toBeLessThanOrEqual(60);
  },
  90_000,
);
