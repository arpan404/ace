import { expect, it, vi } from "vitest";
import { MediaRecording, recoveryMs, stopAckMs } from "./recordings.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

function recording(
  options: {
    private?: () => boolean;
    up?: () => boolean;
    drain?: (decided: number) => Promise<boolean>;
  } = {},
) {
  const clock = new ManualClock();
  const sent: ToMedia[] = [];
  const issued: number[] = [];
  const keyframes: number[] = [];
  const media = new MediaRecording({
    recording: "r1",
    source: "s1",
    directory: "/tmp/r1",
    maxBytes: 1 << 20,
    pointerTrack: true,
    send: (message) => {
      if (!(options.up?.() ?? true)) return false;
      sent.push(message);
      return true;
    },
    clock,
    private: options.private ?? (() => false),
    epoch: 1,
    issue: ({ epoch }) => void issued.push(epoch),
    keyframe: () => void keyframes.push(clock.now()),
    ...(options.drain ? { drain: options.drain } : {}),
  });
  return { media, clock, sent, issued, keyframes };
}

const part = (index: number) => ({
  path: `/tmp/r1/part-000${index}.mp4`,
  index,
  bytes: 100,
  durationMs: 1000,
  gaps: 0,
});

it("issues an epoch every 100 ms and sends each decision once the producer acknowledges", async () => {
  let secret = false;
  const { media, clock, sent, issued } = recording({ private: () => secret });
  expect(media.start()).toBe(true);
  expect(sent[0]).toMatchObject({ type: "record.start", recording: "r1", source: "s1" });
  await clock.advance(100);
  expect(issued).toEqual([2]);
  media.acknowledged(2);
  expect(sent.at(-1)).toEqual({
    type: "record.epochs",
    source: "s1",
    recording: "r1",
    seq: 0,
    decided: 1,
    clear: [[1, 1]],
    discard: [],
  });
  // The tab turns private: a new epoch at once; the one it interrupted is discarded.
  await clock.advance(30);
  secret = true;
  media.privacy();
  expect(issued).toEqual([2, 3]);
  media.acknowledged(3);
  expect(sent.at(-1)).toMatchObject({ seq: 1, decided: 2, clear: [], discard: [[2, 2]] });
});

it("a producer that stops acknowledging has its open epochs discarded and is asked for a keyframe", async () => {
  const { media, clock, sent, keyframes } = recording();
  media.start();
  await clock.advance(2_200);
  const decisions = sent.filter((m) => m.type === "record.epochs");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ seq: 0, clear: [] });
  expect(keyframes).toHaveLength(1);
});

it("keeps every part across an ace-media restart and resolves with them when it stops", async () => {
  const { media, sent } = recording();
  media.start();
  media.message({ type: "record.part", recording: "r1", ...part(0) });
  // A new process reports the part its predecessor's crash cut, then records into part 1.
  media.replay();
  expect(sent.filter((m) => m.type === "record.start")).toHaveLength(2);
  media.message({ type: "record.part", recording: "r1", ...part(0), bytes: 90 });
  media.message({ type: "record.part", recording: "r2", ...part(5) } satisfies FromMedia);
  const stopped = media.stop();
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.at(-1)).toEqual({ type: "record.stop", recording: "r1" });
  media.message({ type: "record.done", recording: "r1", parts: [part(1)] });
  const end = await stopped;
  expect(end).toEqual({ ok: true, parts: [{ ...part(0), bytes: 90 }, part(1)] });
});

it("a recording ace-media fails, or can't stop, ends with its reason and the parts it has", async () => {
  const failed = recording();
  failed.media.start();
  failed.media.message({ type: "record.part", recording: "r1", ...part(0) });
  failed.media.message({ type: "record.failed", recording: "r1", reason: "unsupported-codec" });
  expect(await failed.media.stop()).toEqual({
    ok: false,
    reason: "unsupported-codec",
    parts: [part(0)],
  });

  // ace-media never comes back: the stop ends once its recovery wait is over.
  let up = true;
  const gone = recording({ up: () => up });
  gone.media.start();
  gone.media.message({ type: "record.part", recording: "r1", ...part(0) });
  up = false;
  const stopping = gone.media.stop();
  let settled = false;
  void stopping.then(() => (settled = true));
  await gone.clock.advance(recoveryMs - 1);
  expect(settled).toBe(false);
  await gone.clock.advance(1);
  expect(await stopping).toEqual({ ok: false, reason: "media-unavailable", parts: [part(0)] });
});

it("a stop decides the epoch the producer is in, and drains its frames, before record.stop", async () => {
  const drained = Promise.withResolvers<boolean>();
  const asked: number[] = [];
  const { media, sent, issued } = recording({
    drain: (decided) => (asked.push(decided), drained.promise),
  });
  media.start();
  // Stopped before the first 100 ms beat: epoch 1 holds the whole clip.
  const stopping = media.stop();
  expect(issued).toEqual([2]);
  media.acknowledged(2);
  expect(sent.at(-1)).toMatchObject({ type: "record.epochs", clear: [[1, 1]], discard: [] });
  await Promise.resolve();
  expect(sent.some((m) => m.type === "record.stop")).toBe(false);
  // The barrier asks ace-media for epoch 1, the clip's, to be decided with its frames in.
  expect(asked).toEqual([1]);
  drained.resolve(true);
  await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "record.stop", recording: "r1" }));
  media.message({ type: "record.done", recording: "r1", parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)] });
});

it("a stop while ace-media restarts waits for the new process to recover the part the crash cut", async () => {
  let up = true;
  const { media, sent } = recording({ up: () => up });
  media.start();
  // ace-media dies mid-recording, and the person stops during its restart backoff.
  up = false;
  media.lost("media-exited");
  const stopping = media.stop();
  await Promise.resolve();
  await Promise.resolve();
  up = true;
  const before = sent.length;
  media.replay();
  // The new process recovers part 0 at record.start; nothing more is recorded before the stop.
  expect(sent.slice(before).map((m) => m.type)).toEqual(["record.start", "record.stop"]);
  media.message({ type: "record.part", recording: "r1", ...part(0) });
  media.message({ type: "record.done", recording: "r1", parts: [] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)] });
});

it("stamps a pointer change from just after a resume with the private epoch", async () => {
  let secret = false;
  const { media, clock, sent } = recording({ private: () => secret });
  media.start();
  await clock.advance(50);
  secret = true;
  media.privacy(); // epoch 2, private
  await clock.advance(20);
  secret = false;
  media.privacy(); // epoch 3 follows the private one
  const metaEpochs = () => sent.flatMap((m) => (m.type === "record.meta" ? [m.epoch] : []));
  // The 100 ms beat's epoch, inside the window, doesn't shorten it.
  await clock.advance(99);
  media.meta({ x: 1 });
  expect(metaEpochs()).toEqual([2]);
  await clock.advance(1);
  media.meta({ x: 2 });
  expect(metaEpochs().at(-1)).toBeGreaterThan(2);
});

it("a recording that ended sends nothing more for late acknowledgements", async () => {
  const { media, clock, sent } = recording();
  media.start();
  await clock.advance(100);
  media.message({ type: "record.failed", recording: "r1", reason: "disk-full" });
  const before = sent.length;
  media.acknowledged(2);
  await clock.advance(500);
  expect(sent.length).toBe(before);
});

it("a stop whose barrier can't confirm the last epoch leaves it out and says so", async () => {
  const { media, sent } = recording({ drain: async () => false });
  media.start();
  const stopping = media.stop();
  await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "record.stop", recording: "r1" }));
  media.message({ type: "record.done", recording: "r1", parts: [part(0)] });
  await expect(stopping).resolves.toEqual({ ok: true, parts: [part(0)], truncated: "final-epoch" });
});

it("a record.stop a live ace-media never answers ends the stop in bounded time with what it has", async () => {
  const { media, clock, sent } = recording();
  media.start();
  media.message({ type: "record.part", recording: "r1", ...part(0) });
  const stopping = media.stop();
  await vi.waitFor(() => expect(sent.at(-1)).toEqual({ type: "record.stop", recording: "r1" }));
  let settled = false;
  void stopping.then(() => (settled = true));
  await clock.advance(stopAckMs - 1);
  expect(settled).toBe(false);
  await clock.advance(1);
  await expect(stopping).resolves.toEqual({
    ok: false,
    reason: "stop-unanswered",
    parts: [part(0)],
  });
});
