import { expect, it } from "vitest";
import type { MediaHealth } from "./supervision-policy.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import { recordingStartMs, TeeRecordings, type TeeRecordingSpec } from "./tee-recordings.ts";
import type { IngestSocket } from "./tee.ts";
import type { ToMedia } from "./wire.ts";

function media(initial: { health?: MediaHealth; reason?: string } = {}) {
  const clock = new ManualClock();
  const sent: ToMedia[] = [];
  const state = { health: initial.health ?? "restarting", reason: initial.reason, up: false };
  let needs = 0;
  let next = 0;
  const written: Uint8Array[] = [];
  const socket: IngestSocket = {
    write: (bytes) => (written.push(bytes), true),
    queued: 0,
    destroy: () => {},
  };
  const recordings = new TeeRecordings({
    send: (message) => {
      if (!state.up) return false;
      sent.push(message);
      return true;
    },
    ingest: () => (state.up ? "/run/ingest.sock" : undefined),
    need: () => {
      needs++;
      return () => void needs--;
    },
    health: () => state.health,
    reason: () => state.reason,
    connect: () => socket,
    handle: () => ++next,
    randomBytes: (length) => new Uint8Array(length).fill(7),
    id: () => `id-${++next}`,
    clock,
  });
  const up = () => {
    state.up = true;
    state.health = "healthy";
    recordings.replay();
  };
  return { recordings, clock, sent, state, up, needs: () => needs, written };
}

const spec = (failed: string[] = []): TeeRecordingSpec => ({
  origin: { kind: "scrcpy", host: "127.0.0.1", port: 27183 },
  directory: "/data/recordings/r1",
  maxBytes: 64 << 20,
  private: () => false,
  keyframe: () => {},
  failed: (end) => void failed.push(end.ok ? "ok" : end.reason),
});

it("refuses at once, saying why, while ace-media is unavailable, and holds no use of it", async () => {
  const m = media({ health: "unavailable", reason: "exited 5 times in 2 minutes" });
  const start = await m.recordings.start(spec());
  expect(start).toEqual({
    ok: false,
    reason: "ace-media isn't available to record: exited 5 times in 2 minutes",
  });
  expect(m.sent).toEqual([]);
  expect(m.needs()).toBe(0);
});

it("refuses with a reason when ace-media doesn't start in time, never starting a recording that records nothing", async () => {
  const m = media();
  const starting = m.recordings.start(spec());
  await m.clock.advance(recordingStartMs - 1);
  let settled = false;
  void starting.then(() => (settled = true));
  await m.clock.advance(0);
  expect(settled).toBe(false);
  await m.clock.advance(1);
  await expect(starting).resolves.toEqual({
    ok: false,
    reason: "ace-media isn't available to record: it didn't start in time",
  });
  // Coming up later starts nothing for the refused recording.
  m.up();
  expect(m.sent).toEqual([]);
  expect(m.needs()).toBe(0);
});

it("refuses a waiting recording as soon as ace-media turns unavailable", async () => {
  const m = media();
  const starting = m.recordings.start(spec());
  await m.clock.advance(1_000);
  m.state.health = "unavailable";
  m.state.reason = "the binary exited with code 2";
  m.recordings.exited();
  await expect(starting).resolves.toEqual({
    ok: false,
    reason: "ace-media isn't available to record: the binary exited with code 2",
  });
});

it("starts once ace-media is up: the source opens, then the recording, into the directory given", async () => {
  const m = media();
  const starting = m.recordings.start(spec());
  m.up();
  const start = await starting;
  expect(start.ok).toBe(true);
  expect(m.sent.map((message) => message.type)).toEqual(["source.open", "record.start"]);
  expect(m.sent[1]).toMatchObject({
    type: "record.start",
    directory: "/data/recordings/r1",
    maxBytes: 64 << 20,
    pointerTrack: false,
  });
  expect(m.needs()).toBe(1);
});

it("after ace-media restarts, the recording reopens its source and continues in a new part; stop resolves with every part", async () => {
  const m = media();
  m.up();
  const start = await m.recordings.start(spec());
  if (!start.ok) throw new Error(start.reason);
  const recording = start.recording;
  const record = m.sent.find((message) => message.type === "record.start");
  if (record?.type !== "record.start") throw new Error("no record.start");
  const part = (index: number) => ({
    path: `/data/recordings/r1/part-000${index}.mp4`,
    index,
    bytes: 1000,
    durationMs: 900,
    gaps: index,
  });
  // The crash: ace-media recovers part 0 at the next record.start.
  m.state.up = false;
  m.state.health = "restarting";
  m.recordings.exited();
  m.sent.length = 0;
  m.up();
  expect(m.sent.map((message) => message.type)).toEqual(["source.open", "record.start"]);
  m.recordings.message({ type: "record.part", recording: record.recording, ...part(0) });

  const stopping = recording.stop();
  m.recordings.message({ type: "record.done", recording: record.recording, parts: [part(1)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0), part(1)] });
  expect(m.sent.map((message) => message.type)).toContain("source.close");
  expect(m.needs()).toBe(0);
  expect(m.recordings.active).toBe(0);
});

it("a recording ace-media fails tells its owner, with the parts so far, and releases ace-media", async () => {
  const m = media();
  m.up();
  const failed: string[] = [];
  const start = await m.recordings.start(spec(failed));
  if (!start.ok) throw new Error(start.reason);
  const record = m.sent.find((message) => message.type === "record.start");
  if (record?.type !== "record.start") throw new Error("no record.start");
  m.recordings.message({ type: "record.failed", recording: record.recording, reason: "disk-full" });
  expect(failed).toEqual(["disk-full"]);
  expect(m.needs()).toBe(0);
  expect(m.recordings.active).toBe(0);
  // Units after the end go nowhere.
  const before = m.written.length;
  start.recording.push({
    kind: "video",
    keyframe: true,
    codec: 1,
    width: 2,
    height: 2,
    payload: new Uint8Array([0, 0, 0, 1, 0x65]),
  });
  expect(m.written.length).toBe(before);
});

it("stopping while ace-media is down ends at once with the parts it reported", async () => {
  const m = media();
  m.up();
  const start = await m.recordings.start(spec());
  if (!start.ok) throw new Error(start.reason);
  m.state.up = false;
  await expect(start.recording.stop()).resolves.toEqual({
    ok: false,
    reason: "media-unavailable",
    parts: [],
  });
  expect(m.needs()).toBe(0);
});
