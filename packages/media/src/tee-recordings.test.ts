import { expect, it } from "vitest";
import { decodeMediaFrame } from "./frame.ts";
import { recoveryMs } from "./recordings.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import { readGapMs } from "./epochs.ts";
import {
  ingestLossGraceMs,
  pictureKeyframeMs,
  recordingStartMs,
  restartLossGraceMs,
  syncMs,
  TeeRecordings,
  type TeeRecordingSpec,
} from "./tee-recordings.ts";
import type { IngestSocket } from "./tee.ts";
import type { ToMedia } from "./wire.ts";

/** A fake ace-media at the port: it reports each opened source `starting`, as the real one does. */
function media(initial: { health?: MediaHealth; reason?: string } = {}) {
  const clock = new ManualClock();
  const sent: ToMedia[] = [];
  const state = {
    health: initial.health ?? "restarting",
    reason: initial.reason,
    up: false,
    /** The next ingest connection fails instead of connecting. */
    refuse: false,
    /** ace-media binds each hello (`source.ingest`); off, it never does, as with a bad token. */
    bind: true,
    /** ace-media answers each `source.sync` once it holds. */
    synced: true,
    /** ace-media agreed to the optional features; an older binary didn't. */
    speaks: true,
    /** ace-media's probe found a picture encoder. */
    encoder: true,
    /** The recorded source is private now. */
    secret: false,
  };
  let needs = 0;
  let next = 0;
  let opened = "";
  const written: Uint8Array[] = [];
  const sockets: { drop(): void }[] = [];
  const recordings: TeeRecordings = new TeeRecordings({
    send: (message) => {
      if (!state.up) return false;
      sent.push(message);
      if (message.type === "source.open") {
        opened = message.source;
        queueMicrotask(() =>
          recordings.message({ type: "source.status", source: message.source, status: "starting" }),
        );
      }
      if (message.type === "source.sync" && state.synced)
        queueMicrotask(() =>
          recordings.message({ type: "source.synced", source: message.source, seq: message.seq }),
        );
      return true;
    },
    ingest: () => (state.up ? "/run/ingest.sock" : undefined),
    need: () => {
      needs++;
      return () => void needs--;
    },
    health: () => state.health,
    reason: () => state.reason,
    speaks: () => state.speaks,
    pictureCodecs: () => (state.encoder ? ["avc1.42E033"] : []),
    connect: () => {
      const closes: (() => void)[] = [];
      const socket: IngestSocket = {
        write: (bytes) => (written.push(bytes), true),
        queued: 0,
        destroy: () => void closes.splice(0),
        ready: state.refuse ? Promise.reject(new Error("refused")) : Promise.resolve(),
        onClose: (listener) => void closes.push(listener),
      };
      socket.ready.catch(() => {});
      // ace-media reads the hello and binds the connection to its source.
      const source = opened;
      if (!state.refuse && state.bind && state.speaks)
        queueMicrotask(() => recordings.message({ type: "source.ingest", source }));
      sockets.push({ drop: () => closes.splice(0).forEach((close) => close()) });
      return socket;
    },
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
  const crash = () => {
    state.up = false;
    state.health = "restarting";
    recordings.exited();
  };
  /** What was sent, without the 100 ms epoch decisions. */
  const types = () =>
    sent.map((message) => message.type).filter((type) => type !== "record.epochs");
  return { recordings, clock, sent, state, up, crash, types, needs: () => needs, written, sockets };
}

const part = (index: number) => ({
  path: `/data/recordings/r1/part-000${index}.mp4`,
  index,
  bytes: 1000,
  durationMs: 900,
  gaps: index,
});

const spec = (failed: string[] = [], parts: number[] = []): TeeRecordingSpec => ({
  origin: { kind: "scrcpy", host: "127.0.0.1", port: 27183 },
  directory: "/data/recordings/r1",
  maxBytes: 64 << 20,
  private: () => false,
  keyframe: () => {},
  failed: (end) => void failed.push(end.ok ? "ok" : end.reason),
  part: (closed) => void parts.push(closed.index),
});

const video = {
  kind: "video",
  keyframe: true,
  codec: 1,
  width: 2,
  height: 2,
  payload: new Uint8Array([0, 0, 0, 1, 0x65]),
} as const;

async function started(m: ReturnType<typeof media>, options = spec()) {
  const start = await m.recordings.start(options);
  if (!start.ok) throw new Error(start.reason);
  const record = m.sent.find((message) => message.type === "record.start");
  if (record?.type !== "record.start") throw new Error("no record.start");
  return { recording: start.recording, id: record.recording };
}

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

it("starts once ace-media is up and has taken the ingest connection, into the directory given", async () => {
  const m = media();
  const starting = m.recordings.start(spec());
  m.up();
  const start = await starting;
  expect(start.ok).toBe(true);
  expect(m.types()).toEqual(["source.open", "record.start"]);
  expect(m.sent[1]).toMatchObject({
    type: "record.start",
    directory: "/data/recordings/r1",
    maxBytes: 64 << 20,
    pointerTrack: false,
  });
  expect(m.needs()).toBe(1);
});

it("refuses, saying why, when ace-media never accepts the recording's ingest connection", async () => {
  const m = media();
  m.up();
  m.state.refuse = true;
  await expect(m.recordings.start(spec())).resolves.toEqual({
    ok: false,
    reason: "ace-media isn't available to record: it didn't accept the recording's video",
  });
  expect(m.recordings.active).toBe(0);
  expect(m.needs()).toBe(0);
});

it("an ingest connection lost while ace-media keeps running ends the recording with that reason, never silently", async () => {
  const m = media();
  m.up();
  const failed: string[] = [];
  const { recording, id } = await started(m, spec(failed));
  recording.push(video);
  m.sockets[0]?.drop();
  await m.clock.advance(ingestLossGraceMs);
  // The recording stops in ace-media to keep what it wrote, and the owner hears why.
  await m.clock.advance(200);
  expect(m.types()).toContain("record.stop");
  m.recordings.message({ type: "record.done", recording: id, parts: [part(0)] });
  await m.clock.advance(0);
  expect(failed).toEqual(["ingest-closed"]);
  expect(m.recordings.active).toBe(0);
});

it("a connection lost because ace-media crashed continues in a new part after the restart instead", async () => {
  const m = media();
  m.up();
  const failed: string[] = [];
  await started(m, spec(failed));
  // The crash closes the ingest socket before the supervisor reports the exit.
  m.sockets[0]?.drop();
  m.crash();
  m.sent.length = 0;
  m.up();
  await m.clock.advance(ingestLossGraceMs + 500);
  expect(m.types()).toEqual(["source.open", "record.start"]);
  expect(failed).toEqual([]);
  expect(m.recordings.active).toBe(1);
});

it("after ace-media restarts, the recording reopens its source and continues in a new part; stop resolves with every part", async () => {
  const m = media();
  m.up();
  const closed: number[] = [];
  const { recording, id } = await started(m, spec([], closed));
  m.crash();
  m.sent.length = 0;
  m.up();
  expect(m.types()).toEqual(["source.open", "record.start"]);
  m.recordings.message({ type: "record.part", recording: id, ...part(0) });
  // ace-media binds the new connection before the stop.
  await m.clock.advance(0);

  const stopping = recording.stop();
  await m.clock.advance(200);
  m.recordings.message({ type: "record.done", recording: id, parts: [part(1)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0), part(1)] });
  // The owner hears of each closed part once, for its own budget.
  expect(closed).toEqual([0]);
  expect(m.types()).toContain("source.close");
  expect(m.needs()).toBe(0);
  expect(m.recordings.active).toBe(0);
});

it("a stop during ace-media's restart waits for the new process, which recovers the cut part before the end", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  m.crash();
  const stopping = recording.stop();
  await m.clock.advance(5_000);
  m.sent.length = 0;
  m.up();
  // The source reopens only so record.start can recover the part; the stop follows at once.
  expect(m.types()).toEqual(["source.open", "record.start", "record.stop"]);
  m.recordings.message({ type: "record.part", recording: id, ...part(0) });
  m.recordings.message({ type: "record.done", recording: id, parts: [] });
  // The crash took the moments after the part's last whole fragment, and the stop says so.
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)], truncated: "final-epoch" });
  expect(m.needs()).toBe(0);
});

it("a stop whose ace-media never comes back ends, after the recovery wait, with the parts it reported", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  m.recordings.message({ type: "record.part", recording: id, ...part(0) });
  m.crash();
  const stopping = recording.stop();
  await m.clock.advance(recoveryMs + 200);
  await expect(stopping).resolves.toEqual({
    ok: false,
    reason: "media-unavailable",
    parts: [part(0)],
  });
  expect(m.needs()).toBe(0);
});

it("a recording ace-media fails tells its owner, with the parts so far, and releases ace-media", async () => {
  const m = media();
  m.up();
  const failed: string[] = [];
  const { recording, id } = await started(m, spec(failed));
  m.recordings.message({ type: "record.failed", recording: id, reason: "disk-full" });
  expect(failed).toEqual(["disk-full"]);
  expect(m.needs()).toBe(0);
  expect(m.recordings.active).toBe(0);
  // Units after the end go nowhere.
  const before = m.written.length;
  recording.push(video);
  expect(m.written.length).toBe(before);
});

it("refuses when ace-media never binds the recording's hello, even though its socket connected", async () => {
  const m = media();
  m.up();
  m.state.bind = false;
  const starting = m.recordings.start(spec());
  await m.clock.advance(recordingStartMs);
  await expect(starting).resolves.toEqual({
    ok: false,
    reason: "ace-media isn't available to record: it didn't accept the recording's video",
  });
  expect(m.recordings.active).toBe(0);
});

it("a loss an exit follows, whose restart never takes the video back, still fails in bounded time", async () => {
  const m = media();
  m.up();
  const failed: string[] = [];
  await started(m, spec(failed));
  m.sockets[0]?.drop();
  m.crash();
  // ace-media stays down: the loss doesn't wait out the backoff.
  await m.clock.advance(restartLossGraceMs + 500);
  expect(failed).toEqual([]);
  // The stop can't reach ace-media; it ends after its recovery wait, as a failure.
  await m.clock.advance(recoveryMs);
  expect(failed).toEqual(["ingest-closed"]);
  expect(m.recordings.active).toBe(0);
});

it("a stop in the grace window after a real loss reports the loss, not a clean recording", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  m.sockets[0]?.drop();
  const stopping = recording.stop();
  await m.clock.advance(100);
  m.recordings.message({ type: "record.done", recording: id, parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: false, reason: "ingest-closed", parts: [part(0)] });
});

it("a stop goes out only after ace-media confirms the barrier; without that it says the last epoch was left out", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  recording.push(video);
  m.state.synced = false;
  const stopping = recording.stop();
  await m.clock.advance(syncMs - 1);
  expect(m.types()).not.toContain("record.stop");
  await m.clock.advance(1);
  expect(m.types()).toContain("record.stop");
  m.recordings.message({ type: "record.done", recording: id, parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)], truncated: "final-epoch" });
});

it("with an older ace-media, a recording starts at its ingest connect and its stop says the end may be incomplete", async () => {
  const m = media();
  m.state.speaks = false;
  m.up();
  const { recording, id } = await started(m);
  recording.push(video);
  const stopping = recording.stop();
  await m.clock.advance(0);
  // No barrier the older binary would exit on: the stop goes out at once.
  expect(m.sent.some((message) => message.type === "source.sync")).toBe(false);
  expect(m.types()).toContain("record.stop");
  m.recordings.message({ type: "record.done", recording: id, parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)], truncated: "final-epoch" });
});

it("a stop during an unexplained ingest loss stays a failure, even when a restart's recovery follows", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  // A real loss: ace-media keeps running, and the person stops in the grace window.
  m.sockets[0]?.drop();
  const stopping = recording.stop();
  // Then ace-media dies and comes back before the stop is answered.
  m.crash();
  m.up();
  await m.clock.advance(200);
  m.recordings.message({ type: "record.done", recording: id, parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: false, reason: "ingest-closed", parts: [part(0)] });
});

it("ingest lost while the stop's barrier is pending stays a failure when ace-media then exits and recovers", async () => {
  const m = media();
  m.up();
  const { recording, id } = await started(m);
  recording.push(video);
  m.state.synced = false;
  const stopping = recording.stop();
  // The stop is waiting on source.sync when the video drops, with ace-media still running: the
  // barrier settles false at once and record.stop goes out.
  m.sockets[0]?.drop();
  await m.clock.advance(0);
  expect(m.types()).toContain("record.stop");
  // Then, inside the loss's grace, ace-media exits before answering it, and comes back to
  // recover the part.
  m.crash();
  m.up();
  await m.clock.advance(200);
  m.recordings.message({ type: "record.part", recording: id, ...part(0) });
  m.recordings.message({ type: "record.done", recording: id, parts: [] });
  await expect(stopping).resolves.toEqual({ ok: false, reason: "ingest-closed", parts: [part(0)] });
});

const pictureSpec = (m?: ReturnType<typeof media>): TeeRecordingSpec => ({
  ...spec(),
  private: () => m?.state.secret ?? false,
  origin: { kind: "tab-pictures" },
  encode: { codec: "avc1.42E033", width: 1280, height: 720, fps: 15, bitrate: 4_000_000 },
});

const jpeg = {
  kind: "picture",
  keyframe: false,
  codec: 7,
  width: 1280,
  height: 720,
  payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
} as const;

it("records a picture source through its own encode, opened before anyone watches and again after a restart", async () => {
  const m = media();
  m.up();
  const { recording } = await started(m, pictureSpec());
  const encodes = () =>
    m.sent.filter((message) => message.type === "source.encodes").map((message) => message);
  expect(encodes()).toEqual([
    {
      type: "source.encodes",
      source: expect.stringMatching(/^recording:/),
      encodes: [
        { id: 1, codec: "avc1.42E033", width: 1280, height: 720, fps: 15, bitrate: 4_000_000 },
      ],
    },
  ]);
  recording.push(jpeg);
  // The picture goes in whole, as a still picture ace-media encodes: none waits for a keyframe.
  const frames = m.written.map((bytes) => decodeMediaFrame(bytes));
  expect(frames.map((frame) => [frame.kind, frame.codec, frame.flags & 1])).toEqual([
    [5, 0, 0],
    [3, 7, 1],
  ]);
  m.crash();
  m.up();
  await Promise.resolve();
  expect(encodes()).toHaveLength(2);
});

it("asks a picture recording's own encode for the keyframe ace-media wants, never the producer", async () => {
  const m = media();
  m.up();
  const asked: string[] = [];
  await started(m, { ...pictureSpec(), keyframe: () => asked.push("producer") });
  const open = m.sent.find((message) => message.type === "source.open");
  if (open?.type !== "source.open") throw new Error("no source.open");
  const keys = () => m.sent.filter((message) => message.type === "source.key");
  const before = keys().length;
  // ace-media's recording resumes after a discarded epoch and needs a clear keyframe.
  m.recordings.message({
    type: "source.keyframe",
    source: open.source,
    encode: 1,
    reason: "resume",
  });
  expect(keys().slice(before)).toEqual([{ type: "source.key", source: open.source, encode: 1 }]);
  expect(asked).toEqual([]);
});

it("passes ace-media's keyframe ask on to an encoded source's producer", async () => {
  const m = media();
  m.up();
  let asked = 0;
  await started(m, { ...spec(), keyframe: () => void asked++ });
  const open = m.sent.find((message) => message.type === "source.open");
  if (open?.type !== "source.open") throw new Error("no source.open");
  const before = asked;
  m.recordings.message({
    type: "source.keyframe",
    source: open.source,
    encode: 0,
    reason: "resume",
  });
  expect(asked).toBe(before + 1);
});

it("refuses a picture recording, saying why, on an ace-media that can't encode pictures", async () => {
  const m = media();
  m.state.speaks = false;
  m.up();
  const start = await m.recordings.start(pictureSpec());
  expect(start).toEqual({
    ok: false,
    reason:
      "ace-media isn't available to record: this ace-media is too old to record pictures; update ace",
  });
  expect(m.types()).toEqual([]);
  expect(m.needs()).toBe(0);
});

it("holds a picture recording's encode after a restart until the new ace-media found an encoder", async () => {
  const m = media();
  m.up();
  await started(m, pictureSpec());
  const encodes = () => m.sent.filter((message) => message.type === "source.encodes").length;
  expect(encodes()).toBe(1);
  // The new process reports its last-resort encoder only after `ready`: an encode asked before
  // that would end the source.
  m.crash();
  m.state.encoder = false;
  m.up();
  await Promise.resolve();
  expect(encodes()).toBe(1);
  m.state.encoder = true;
  m.recordings.message({ type: "capabilities.changed", capabilities: [] });
  expect(encodes()).toBe(2);
});

it("waits for ace-media's encoder before a picture recording starts, and refuses without one", async () => {
  const m = media();
  m.state.encoder = false;
  m.up();
  const waiting = m.recordings.start(pictureSpec());
  await m.clock.advance(recordingStartMs);
  expect(await waiting).toEqual({
    ok: false,
    reason: "ace-media isn't available to record: it found no video encoder on this computer",
  });
  const late = m.recordings.start(pictureSpec());
  await Promise.resolve();
  m.state.encoder = true;
  m.recordings.message({ type: "capabilities.changed", capabilities: [] });
  expect((await late).ok).toBe(true);
});

it("stamps a picture recording's pictures with a new epoch only once ace-media applied it", async () => {
  const m = media();
  m.up();
  const { recording } = await started(m, pictureSpec());
  const open = m.sent.find((message) => message.type === "source.open");
  if (open?.type !== "source.open") throw new Error("no source.open");
  const pictureEpochs = () =>
    m.written
      .map((bytes) => decodeMediaFrame(bytes))
      .filter((f) => f.kind === 3)
      .map((f) => f.epoch);
  recording.privacy();
  const told = m.sent.filter((message) => message.type === "source.epoch");
  expect(told).toEqual([
    { type: "source.epoch", source: open.source, seq: 0, epoch: 2, followsPrivate: false },
  ]);
  // ace-media hasn't applied epoch 2 yet: a picture read now keeps epoch 1.
  recording.push(jpeg);
  m.recordings.message({ type: "epoch.applied", source: open.source, seq: 0, epoch: 2 });
  recording.push(jpeg);
  expect(pictureEpochs()).toEqual([1, 2]);
});

it("asks a picture recording's encode for a keyframe regularly, and once a resume's read gap passed", async () => {
  const m = media();
  m.up();
  const { recording } = await started(m, pictureSpec(m));
  const open = m.sent.find((message) => message.type === "source.open");
  if (open?.type !== "source.open") throw new Error("no source.open");
  const keys = () => m.sent.filter((message) => message.type === "source.key").length;
  const before = keys();
  await m.clock.advance(pictureKeyframeMs);
  expect(keys()).toBe(before + 1);
  // Private, then public again: once ace-media applied the epoch after the private one, a
  // keyframe is asked as soon as pictures read are past the read gap.
  m.state.secret = true;
  recording.privacy();
  m.state.secret = false;
  recording.privacy();
  const followsPrivate = m.sent.findLast((message) => message.type === "source.epoch");
  if (followsPrivate?.type !== "source.epoch") throw new Error("no source.epoch");
  expect(followsPrivate.followsPrivate).toBe(true);
  m.recordings.message({
    type: "epoch.applied",
    source: open.source,
    seq: followsPrivate.seq,
    epoch: followsPrivate.epoch,
  });
  await m.clock.advance(readGapMs);
  expect(keys()).toBe(before + 1);
  await m.clock.advance(100);
  expect(keys()).toBe(before + 2);
  void recording.stop();
  await m.clock.advance(pictureKeyframeMs * 2);
  expect(keys()).toBe(before + 2);
});
