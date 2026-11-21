import { expect, it } from "vitest";
import type { IngestProducer } from "@ace/media/ingest-sources";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import { DeviceVideoPaths, type Switched } from "./media-paths.ts";
import type { VideoUnit } from "./scrcpy-video.ts";

const annexB = (keyframe: boolean, mark: number) =>
  Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41, mark]);

/** A device's video paths with a scripted producer and a stand-in for ace-media. */
function device() {
  const emitted: VideoUnit[] = [];
  const answers: Switched[] = [];
  /** What the producer sends while it switches (a fresh subscription's first unit, say). */
  const during: (() => void)[] = [];
  const keyframes: string[] = [];
  let producer: IngestProducer | undefined;
  const codecs: string[][] = [];
  const paths = new DeviceVideoPaths({
    media: {
      attach: (added) => {
        producer = added;
        return {
          streaming: () => false,
          reconnect: () => {},
          codecs: (told) => void codecs.push([...told]),
          encodes: () => {},
          key: () => {},
          picture: () => false,
          close: () => {},
        };
      },
    },
    source: "emulator:1",
    kind: "emulator-frames",
    origin: { kind: "emulator-frames", path: "/tmp/f.rgba", width: 4, height: 4, stride: 16 },
    deviceId: "d1",
    emit: (unit) => void emitted.push(unit),
    switch: async () => {
      during.shift()?.();
      return answers.shift() ?? { ingest: "off", boundary: null };
    },
    keyframe: () => void keyframes.push("key"),
    schedule: () => () => {},
  });
  const ready = () => {
    if (!producer) throw new Error("no producer");
    return producer;
  };
  const daemon = (sequence: number, keyframe = false) =>
    paths.daemon({
      sequence,
      payload: annexB(keyframe, sequence),
      keyframe,
      videoCodec: "avc1.640033",
      width: 4,
      height: 4,
      pts: BigInt(sequence),
    });
  const egress = (path: string, sequence: number, keyframe = false) =>
    ready().consumers.record({
      source: path,
      sequence,
      gap: false,
      frame: {
        kind: 1,
        flags: keyframe ? 1 : 0,
        ageUs: 0,
        width: 4,
        height: 4,
        displayWidth: 4,
        displayHeight: 4,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 0,
        codecString: keyframe ? "avc1.640033" : "",
        description: new Uint8Array(0),
        extension: encodeProducerStamp({ sequence, timestamp: sequence, scale: 1 }),
        payload: annexB(keyframe, sequence),
      },
    });
  const marks = () => emitted.map((unit) => unit.payload[5]);
  return { paths, answers, during, keyframes, producer: ready, daemon, egress, marks, codecs };
}

const address = (path: string) => ({
  url: "ws://127.0.0.1:1/ingest",
  socket: "/run/m1i.sock",
  token: new Uint8Array(32),
  epoch: 0,
  path,
});

it("a device tells ace-media it encodes H.264 only, so no view is planned in HEVC", () => {
  expect(device().codecs).toEqual([["avc1.42E033"]]);
});

it("a move into ace-media hands on the daemon path's units up to its boundary before ace-media's", async () => {
  const d = device();
  d.daemon(1, true);
  d.answers.push({ ingest: "on", boundary: 3 });
  await d.producer().point(address("p1"));
  // ace-media's keyframe overtakes the daemon path's last two deltas.
  d.egress("p1", 4, true);
  d.daemon(2);
  d.daemon(3);
  d.egress("p1", 5);
  expect(d.marks()).toEqual([1, 2, 3, 4, 5]);
  expect(d.paths.stale).toBe(0);
});

it("a move back while ace-media still holds the old path's units loses and repeats none", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.answers.push({ ingest: "off", boundary: 3 });
  await d.producer().point(undefined);
  // The daemon path's new keyframe arrives while units 2 and 3 are still on their way.
  d.daemon(4, true);
  d.egress("p1", 2);
  d.egress("p1", 3);
  d.producer().pathEnded?.("p1", false);
  d.daemon(5);
  expect(d.marks()).toEqual([1, 2, 3, 4, 5]);
  expect(d.paths.stale).toBe(0);
});

it("a failed ingest connection puts video back on the daemon path from its next keyframe", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.egress("p1", 2);
  d.paths.ingestClosed();
  // Units the producer had sent ace-media may be lost: a delta before the keyframe can't decode.
  d.daemon(4);
  d.daemon(5, true);
  d.daemon(6);
  expect(d.marks()).toEqual([1, 2, 5, 6]);
});

it("a producer that refuses ace-media's address stays on the daemon path", async () => {
  const d = device();
  d.answers.push({ ingest: "off", boundary: null });
  await expect(d.producer().point(address("p1"))).rejects.toThrow("refused");
  d.daemon(1, true);
  d.egress("p1", 2, true);
  expect(d.marks()).toEqual([1]);
});

it("paths that carry one live stream are cut at a switch: the new path starts at its keyframe and nothing older repeats", async () => {
  const d = device();
  d.daemon(1, true);
  d.daemon(2);
  d.answers.push({ ingest: "on", boundary: null, cut: true });
  await d.producer().point(address("p1"));
  // ace-media's reader was already running: its older deltas are superseded by its keyframe.
  d.egress("p1", 2);
  d.egress("p1", 3, true);
  d.egress("p1", 4);
  d.daemon(3);
  expect(d.marks()).toEqual([1, 2, 3, 4]);
  d.answers.push({ ingest: "off", boundary: null, cut: true });
  // The daemon's fresh subscription opens with a keyframe; ace-media's last deltas are older.
  d.during.push(() => d.daemon(6, true));
  await d.producer().point(undefined);
  d.egress("p1", 5);
  d.daemon(7);
  expect(d.marks()).toEqual([1, 2, 3, 4, 6, 7]);
});

it("a path that ends interrupted asks the producer for the keyframe its successor needs", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  // ace-media went away: its path ends cut, and the daemon's path restarts at a keyframe.
  d.answers.push({ ingest: "off", boundary: null });
  await d.producer().point(undefined);
  expect(d.keyframes).toEqual([]);
  d.producer().pathEnded?.("p1", true);
  expect(d.keyframes).toEqual(["key"]);
  d.daemon(2);
  d.daemon(3, true);
  expect(d.marks()).toEqual([1, 3]);
});
