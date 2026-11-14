import { expect, it } from "vitest";
import { MediaRecording, recordingRoute } from "./recordings.ts";
import { legacyMediaSettings } from "./supervision-policy.ts";
import { ManualClock } from "./supervisor-test-support.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

function recording(options: { private?: () => boolean; up?: () => boolean } = {}) {
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

it("routes a recording to ace-media only when the setting is auto and ace-media is healthy", () => {
  const auto = { ...legacyMediaSettings, recordings: "auto" } as const;
  expect(recordingRoute(legacyMediaSettings, "healthy")).toBe("legacy");
  expect(recordingRoute(auto, "healthy")).toBe("ace-media");
  expect(recordingRoute(auto, "restarting")).toBe("legacy");
  expect(recordingRoute(auto, "unavailable")).toBe("legacy");
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

  let up = true;
  const gone = recording({ up: () => up });
  gone.media.start();
  up = false;
  expect(await gone.media.stop()).toMatchObject({ ok: false, reason: "media-unavailable" });
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
