import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MediaRecording, recordingRoute } from "./recordings.ts";
import {
  legacyMediaSettings,
  MediaSupervisor,
  nodeMediaHost,
  systemMediaClock,
  type MediaExit,
} from "./supervisor.ts";
import { MediaTee, nodeIngestConnect } from "./tee.ts";

// The daemon's recording route against the real ace-media (`bun run check:media` builds it and
// sets ACE_MEDIA_TEST_BINARY): the supervisor, a tee'd H.264 source stamped at read time, the
// 100 ms epochs and their decisions, the source going private and public, and ace-media killed
// mid-recording. Unit tests can't show the parts that come out the other end.
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

it.runIf(binary)(
  "records a tee'd source through ace-media: nothing private written, and a kill -9 continues in a new part",
  async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ace-media-rec-"));
    const directory = join(runtimeDir, "recording");
    const settings = { ...legacyMediaSettings, recordings: "auto" } as const;
    const exits: MediaExit[] = [];
    let secret = false;
    let handle = 0;
    let recording: MediaRecording | undefined;
    let tee: MediaTee | undefined;
    const supervisor: MediaSupervisor = new MediaSupervisor({
      version: execFileSync(binary ?? "", ["--version"])
        .toString()
        .trim(),
      binary: binary ?? "",
      runtimeDir,
      dataDir: runtimeDir,
      settings: () => settings,
      host: nodeMediaHost(process.env),
      clock: systemMediaClock,
      random: Math.random,
      listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
      // The daemon's state is the truth: reopen the source at its current epoch, then the
      // recording, which continues in a new part.
      replay: () => {
        if (!tee || !recording) return;
        tee.open();
        recording.replay();
      },
      onMessage: (message) => {
        tee?.message(message);
        recording?.message(message);
      },
      onEgress: () => {},
      onExit: (exit) => void exits.push(exit),
      log: () => {},
    });
    cleanups.push(() => {
      supervisor.dispose();
      rmSync(runtimeDir, { recursive: true, force: true });
    });
    const release = supervisor.need();
    await until(() => supervisor.health() === "healthy");
    expect(recordingRoute(settings, supervisor.health())).toBe("ace-media");

    tee = new MediaTee(
      {
        source: "s1",
        handle: () => ++handle,
        origin: { kind: "tab" },
        send: (message, payload) => supervisor.send(message, payload),
        ingest: () => supervisor.ingest()?.socket,
        connect: nodeIngestConnect,
        now: () => performance.now(),
        randomBytes: (n) => new Uint8Array(randomBytes(n)),
        keyframe: () => {},
      },
      1,
    );
    recording = new MediaRecording({
      recording: "r1",
      source: "s1",
      directory,
      maxBytes: 1 << 20,
      pointerTrack: false,
      send: (message) => supervisor.send(message),
      clock: systemMediaClock,
      private: () => secret,
      epoch: 1,
      // The tee applies each epoch as it gets it, so it acknowledges at once.
      issue: (issued) => recording?.acknowledged(tee?.epoch(issued) ?? issued.epoch),
      keyframe: () => {},
    });
    expect(tee.open()).toBe(true);
    expect(recording.start()).toBe(true);

    const privateIds = new Set<number>();
    let id = 0;
    const play = async (frames: number) => {
      for (let n = 0; n < frames; n++, id++) {
        if (secret) privateIds.add(id);
        tee?.push({
          kind: "video",
          keyframe: n % 5 === 0,
          codec: 2,
          width: 64,
          height: 64,
          ...(n % 5 === 0 ? { description: avcc } : {}),
          payload: tagged(id),
        });
        await sleep(20);
      }
    };
    const transition = (to: boolean) => {
      secret = to;
      recording?.privacy();
    };

    await play(30);
    transition(true);
    await play(15);
    transition(false);
    await play(30);

    // Kill ace-media mid-recording; the supervisor restarts it and replays.
    const pid = supervisor.snapshot().pid ?? 0;
    process.kill(pid, "SIGKILL");
    await until(() => exits.length === 1);
    expect(exits[0]).toMatchObject({ failure: true, recordings: ["r1"] });
    await until(() => supervisor.health() === "healthy" && supervisor.snapshot().pid !== pid);
    await until(() => recording?.parts.some((p) => p.index === 0) ?? false);
    await play(30);
    transition(true);
    await play(10);
    transition(false);
    await play(30);

    const end = await recording.stop();
    release();
    expect(end.ok, JSON.stringify(end)).toBe(true);
    expect(end.parts.map((p) => p.index)).toEqual([0, 1]);
    const written = end.parts.flatMap((p) => ids(p.path));
    expect(
      written.filter((n) => privateIds.has(n)),
      "frames read while private",
    ).toEqual([]);
    // Most public frames survive: only the open group at the kill and frames read within
    // 100 ms of a resume (or before the first keyframe after one) may be missing.
    expect(written.length).toBeGreaterThan(80);
    expect(written).toEqual([...written].sort((a, b) => a - b));
  },
  60_000,
);
