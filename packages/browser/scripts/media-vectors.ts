import { encodeStream, streamKinds } from "../src/stream-envelope.ts";
import { encodeBrowserVideo } from "../src/stream-video.ts";
import { encodeBrowserAudio } from "../src/stream-audio.ts";
import { encodePicture } from "../src/stream-picture.ts";
import { VideoChunkGate } from "../src/video-gate.ts";
import { VideoFanout, type VideoPiece } from "../src/video-fanout.ts";
import { LinkRate } from "../src/link-rate.ts";
import { PictureScale } from "../src/video-scale.ts";
import { planVideo } from "../src/video-policy.ts";
import { QuantizerControl } from "../src/quantizer-control.ts";
import { writeVectors } from "./media-vector-harness.ts";
import { fanoutEdges, linkRateEdges } from "./media-pacing-vectors.ts";
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
  const scale = new PictureScale();
  const scales = [
    [0, 16000000],
    [100, 500000],
    [1099, 500000],
    [1100, 500000],
    [2000, 16000000],
    [4999, 16000000],
    [5000, 16000000],
  ];
  const rate = new LinkRate({ min: 500000, max: 16000000, initial: 1000000 });
  const rateSteps = Array.from({ length: 60 }, (_, i) => ({
    at: i * 250,
    rtt: i < 20 ? 20 : 300,
    bytes: 32000,
  }));
  const q = new QuantizerControl(1000000, 60);
  const qSteps = Array.from({ length: 24 }, (_, i) => ({
    bytes: i < 12 ? 20000 : 100,
    key: i % 8 === 0,
  }));
  const events: unknown[] = [];
  const fanout = new VideoFanout<VideoPiece>({
    window: { frames: 2, bytes: 30 },
    keyframe: (encode) => events.push({ keyframe: encode }),
    playing: (id, playing) => events.push({ id, playing }),
    dropped: (id) => events.push({ dropped: id }),
  });
  fanout.add("v", {
    send: (chunk) => {
      events.push({ sent: chunk.sequence });
      return true;
    },
  });
  fanout.assign("v", "e");
  const fanoutSteps = Array.from({ length: 8 }, (_, i) => ({
    sequence: i,
    key: i % 3 === 0,
    bytes: { length: 10 },
  }));
  for (const chunk of fanoutSteps) {
    fanout.publish("e", chunk);
    if (chunk.sequence === 5) fanout.acknowledge("v", 4);
  }
  const source = { width: 1920, height: 1080, scale: 2, codecs: ["avc1.42001f", "vp9"] };
  const viewers = Array.from({ length: 7 }, (_, i) => ({
    id: `v${i}`,
    viewport: { width: 1800 - i * 200, height: 1000 - i * 100, devicePixelRatio: 1 },
    codecs: ["avc1.42001f"],
    link: 8000000 - i * 900000,
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
    scale: scales.map(([now, link]) => ({
      input: { now, link, pixels: 1920 * 1080, fps: 60 },
      output: scale.update(link ?? 0, 1920 * 1080, 60, now ?? 0),
    })),
    "link-rate": rateSteps.map((input, i) => {
      rate.sent(i, input.bytes, input.at);
      rate.acknowledged(i, input.at + input.rtt);
      if (i === 40) rate.dropped(input.at + input.rtt);
      return { input, drop: i === 40, output: { rate: rate.rate, rtt: rate.rtt } };
    }),
    quantizer: qSteps.map((input) => {
      const next = q.next(input.key);
      q.observe(input.bytes, input.key);
      return { input, output: { next, settled: input.key ? q.settled() : undefined } };
    }),
    fanout: { steps: fanoutSteps, ack: { after: 5, sequence: 4 }, events },
    "fanout-edges": fanoutEdges(),
    "link-rate-edges": linkRateEdges(),
    plan: { input: { source, viewers }, output: planVideo(source, viewers) },
  };
}
if (import.meta.main) writeVectors(mediaVectors());
