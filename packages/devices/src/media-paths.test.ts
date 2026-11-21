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
  const egress = (path: string, sequence: number, keyframe = false) =>
    ready().consumers.deliver({
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
  return { paths, answers, during, keyframes, producer: ready, egress, marks, codecs };
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

it("a first move into ace-media hands its units on at once: nothing streamed before", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.egress("p1", 2);
  expect(d.marks()).toEqual([1, 2]);
  expect(d.paths.stale).toBe(0);
});

it("a move to a new ace-media path holds its units until the old path's last ones are in", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.answers.push({ ingest: "on", boundary: 3 });
  await d.producer().point(address("p2"));
  // The new path's keyframe overtakes the old path's last deltas.
  d.egress("p2", 4, true);
  d.egress("p1", 2);
  d.egress("p1", 3);
  d.producer().pathEnded?.("p1", false);
  d.egress("p2", 5);
  expect(d.marks()).toEqual([1, 2, 3, 4, 5]);
  expect(d.paths.stale).toBe(0);
});

it("a failed ingest connection stops video, and the next path starts at its keyframe", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.egress("p1", 2);
  d.paths.ingestClosed();
  expect(d.keyframes).toEqual(["key"]);
  d.producer().pathEnded?.("p1", true);
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p2"));
  // Units the producer had sent ace-media may be lost: a delta before the keyframe can't decode.
  d.egress("p2", 4);
  d.egress("p2", 5, true);
  d.egress("p2", 6);
  expect(d.marks()).toEqual([1, 2, 5, 6]);
});

it("a producer that refuses ace-media's address streams nothing", async () => {
  const d = device();
  d.answers.push({ ingest: "off", boundary: null });
  await expect(d.producer().point(address("p1"))).rejects.toThrow("refused");
  d.egress("p1", 2, true);
  expect(d.marks()).toEqual([]);
});

it("paths that carry one live stream are cut at a switch: the new path starts at its keyframe and nothing older repeats", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null, cut: true });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  d.egress("p1", 2);
  d.answers.push({ ingest: "on", boundary: null, cut: true });
  await d.producer().point(address("p2"));
  // The new reader was already running: its older deltas are superseded by its keyframe.
  d.egress("p2", 2);
  d.egress("p2", 3, true);
  d.egress("p2", 4);
  // The old path's late units are never repeated.
  d.egress("p1", 3);
  expect(d.marks()).toEqual([1, 2, 3, 4]);
});

it("a path that ends interrupted asks the producer for the keyframe its successor needs", async () => {
  const d = device();
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p1"));
  d.egress("p1", 1, true);
  // ace-media went away: video stops, and its path ends cut.
  d.answers.push({ ingest: "off", boundary: null });
  await d.producer().point(undefined);
  expect(d.keyframes).toEqual([]);
  d.producer().pathEnded?.("p1", true);
  expect(d.keyframes).toEqual(["key"]);
  d.answers.push({ ingest: "on", boundary: null });
  await d.producer().point(address("p2"));
  d.egress("p2", 2);
  d.egress("p2", 3, true);
  expect(d.marks()).toEqual([1, 3]);
});
