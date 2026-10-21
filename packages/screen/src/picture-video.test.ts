import { expect, test } from "vitest";
import type { CaptureEvents, VideoHost } from "@ace/browser";
import type { ScreenStreamSettings } from "@ace/protocol";
import { framePacket, type Frame } from "./frames.ts";
import { PicturesToVideo } from "./picture-video.ts";

// An H.264 High 5.1 decoder configuration (avcC) for a 1206×2622 picture, as WebCodecs gives it.
const description = Buffer.from(
  "01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0",
  "hex",
);
const lengthPrefixed = (nal: number[]) => Buffer.from([0, 0, 0, nal.length, ...nal]);

function jpeg(sequence: number, width = 1280, height = 800): Frame {
  const payload = Buffer.from(`jpeg-${sequence}`);
  const header = {
    version: 1 as const,
    sessionId: "session-1",
    sequence,
    timestamp: sequence,
    width,
    height,
    scale: 2,
    codec: "jpeg" as const,
    bytes: payload.length,
  };
  const packet = framePacket(header, payload);
  return { header, payload: packet.subarray(packet.length - payload.length), packet };
}

/** An encoder-only Chrome stand-in: it records what it is fed and encodes on request. */
function encoder() {
  const pushed: string[] = [];
  const encodes: { key: string; width: number; height: number; bitrate: number }[][] = [];
  const keyframes: string[] = [];
  let events: CaptureEvents | undefined;
  const host: VideoHost = {
    supported: async (codecs) => codecs.filter((codec) => codec === "avc1.42E033"),
    open: async () => {
      throw new Error("no tabs here");
    },
    encodePictures: async (_width, _height, given) => {
      events = given;
      return {
        encodes: (specs) =>
          encodes.push(
            specs.map(({ key, width, height, bitrate }) => ({ key, width, height, bitrate })),
          ),
        keyframe: (key) => keyframes.push(key),
        pictures: { width: 1280, height: 800, push: (data) => pushed.push(data) },
        close: () => {},
      };
    },
  };
  const emit = (key: boolean) => {
    const spec = encodes.at(-1)?.[0];
    if (!spec || !events) throw new Error("No encode");
    events.chunk({
      encode: spec.key,
      key,
      codec: "avc1.42E033",
      codedWidth: spec.width,
      codedHeight: spec.height,
      ...(key ? { description } : {}),
      bytes: lengthPrefixed(key ? [0x25, 0xb8, 0x00] : [0x21, 0x9a]),
    });
  };
  return { host, pushed, encodes, keyframes, emit };
}

const settings: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 640,
  maxHeight: 640,
  fps: 60,
  bitrate: 2_000_000,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a JPEG-only session reaches its viewer as H.264 in Annex B, sized to the viewer's box", async () => {
  const fake = encoder();
  const frames: Frame[] = [];
  const video = new PicturesToVideo({
    host: () => fake.host,
    sessionId: "session-1",
    now: () => 5,
    frame: (frame) => frames.push(frame),
  });
  // Nothing is encoded until a viewer asks for video.
  video.push(jpeg(1));
  await settle();
  expect(fake.encodes).toEqual([]);

  expect(video.want(settings)).toBe(true);
  video.push(jpeg(2));
  await settle();
  expect(fake.encodes.at(-1)).toEqual([
    { key: "avc1.42E033:640x400", width: 640, height: 400, bitrate: 2_000_000 },
  ]);
  expect(fake.pushed).toEqual([Buffer.from("jpeg-2").toString("base64")]);

  fake.emit(true);
  fake.emit(false);
  expect(frames.map((frame) => frame.header)).toMatchObject([
    { codec: "h264", keyframe: true, videoCodec: "avc1.640033", width: 640, height: 400, scale: 1 },
    { codec: "h264", keyframe: false, width: 640, height: 400 },
  ]);
  // The keyframe leads with its parameter sets; every NAL unit has a start code.
  expect(frames[0]?.payload.subarray(0, 5)).toEqual(Buffer.from([0, 0, 0, 1, 0x27]));
  expect(frames[1]?.payload).toEqual(Buffer.from([0, 0, 0, 1, 0x21, 0x9a]));
});

test("a viewer's new bit rate and keyframe requests reach the encode; stopping ends it", async () => {
  const fake = encoder();
  const video = new PicturesToVideo({
    host: () => fake.host,
    sessionId: "session-1",
    now: () => 5,
    frame: () => {},
  });
  video.want(settings);
  video.push(jpeg(1));
  await settle();
  video.want({ ...settings, bitrate: 900_000 });
  expect(fake.encodes.at(-1)?.[0]?.bitrate).toBe(900_000);
  expect(video.keyframe()).toBe(true);
  expect(fake.keyframes).toEqual(["avc1.42E033:640x400"]);
  video.stop();
  expect(video.keyframe()).toBe(false);
  video.push(jpeg(2));
  await settle();
  expect(fake.pushed).toHaveLength(1);
});

test("without an encoder-only Chrome, a JPEG-only session can't give a viewer video", () => {
  const video = new PicturesToVideo({
    host: () => undefined,
    sessionId: "session-1",
    now: () => 5,
    frame: () => {},
  });
  expect(video.want(settings)).toBe(false);
});
