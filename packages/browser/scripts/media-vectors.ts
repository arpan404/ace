import { encodeStream, streamKinds } from "../src/stream-envelope.ts";
import { encodeBrowserAudio, encodeBrowserVideo, encodePicture } from "../src/stream-encode.ts";
import { VideoChunkGate } from "../src/video-gate.ts";
import { QuantizerControl } from "../src/quantizer-control.ts";
import { writeVectors } from "./media-vector-harness.ts";
import { quantizerCap } from "./media-step-vectors.ts";

/*
 * The browser's shared vectors whose TypeScript still runs: the stream envelope and headers
 * (clients decode them), the chunk gate and the quantizer. Fanout, link rate, link hints, scale,
 * plans and link caps went with legacy delivery (X3); their vectors are frozen in
 * `native/media/vectors` and owned by the Rust tests.
 */
export function mediaVectors() {
  const gate = new VideoChunkGate();
  const offers = [
    [true, true],
    [false, false],
    [false, true],
    [true, false],
    [true, true],
    [false, true],
  ] as const;
  const q = new QuantizerControl(1000000, 60);
  const qSteps = Array.from({ length: 24 }, (_, i) => ({
    bytes: i < 12 ? 20000 : 100,
    key: i % 8 === 0,
  }));
  const video = {
    sequence: 7,
    timestamp: 120,
    width: 1920,
    height: 1080,
    codedWidth: 1280,
    codedHeight: 720,
    codec: "avc1.42001f",
    key: true,
    description: new Uint8Array([1, 2]),
    tabId: "tab-1",
  };
  const audio = {
    sequence: 8,
    timestamp: 125,
    sampleRate: 48000,
    channels: 2,
    codec: "opus",
    tabId: "tab-1",
  };
  const picture = {
    sequence: 9,
    timestamp: 130,
    width: 1280,
    height: 720,
    scale: 1.5,
    rotation: 90 as const,
    codec: "jpeg",
    key: true,
    streamId: "stream-1",
  };
  const payload = new Uint8Array([1, 2, 3, 4]);
  return {
    envelope: [1, 65500, 65536, 131072].map((length) => ({
      input: { kind: 2, id: 42, meta: [1, 2], payloadLength: length, payloadByte: 7 },
      pieces: encodeStream(2, 42, new Uint8Array([1, 2]), new Uint8Array(length).fill(7)),
    })),
    headers: {
      video: { input: video, pieces: encodeBrowserVideo(1, "thread-1", video, payload) },
      audio: { input: audio, pieces: encodeBrowserAudio(2, "thread-1", audio, payload) },
      pictures: [streamKinds.deviceFrame, streamKinds.screenFrame].map((kind) => ({
        kind,
        input: picture,
        pieces: encodePicture(kind, 3, "source-1", picture, payload),
      })),
      payload,
    },
    gate: offers.map(([key, accept]) => ({
      input: { key, accept },
      output: gate.offer("c", "e", key, () => accept),
    })),
    quantizer: qSteps.map((input) => {
      const next = q.next(input.key);
      q.observe(input.bytes, input.key);
      return { input, output: { next, settled: input.key ? q.settled() : undefined } };
    }),
    "quantizer-cap": quantizerCap(),
  };
}
if (import.meta.main) writeVectors(mediaVectors());
