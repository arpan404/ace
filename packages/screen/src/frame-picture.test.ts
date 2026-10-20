import { expect, it } from "vitest";
import { framePicture } from "./frame-picture.ts";
import type { Frame } from "./frames.ts";

function frame(header: Partial<Frame["header"]> = {}): Frame {
  const payload = Buffer.from([1, 2, 3]);
  return {
    header: {
      version: 1,
      sessionId: "session-1",
      sequence: 4,
      timestamp: 1000,
      width: 1280,
      height: 800,
      codec: "jpeg",
      bytes: payload.length,
      ...header,
    },
    payload,
    packet: payload,
  };
}

it("a restarted capture is a new stream, so a viewer starts it over at a keyframe", () => {
  const first = framePicture(frame({ captureGeneration: 1 }));
  const second = framePicture(frame({ captureGeneration: 2 }));
  expect(first.streamId).not.toBe(second.streamId);
  expect(framePicture(frame()).streamId).toBe("session-1");
  // A session id at the limit still leaves room for the generation.
  const long = framePicture(frame({ sessionId: "s".repeat(64), captureGeneration: 12 }));
  expect(long.streamId).toHaveLength(64);
  expect(long.streamId.endsWith("-g12")).toBe(true);
});

it("the helper's H.264 keeps its codec, keyframe flag, size and scale", () => {
  const key = framePicture(
    frame({ codec: "h264", keyframe: true, videoCodec: "avc1.640028", scale: 2 }),
  );
  expect(key).toMatchObject({
    codec: "avc1.640028",
    key: true,
    codecNamed: true,
    width: 1280,
    height: 800,
    scale: 2,
    rotation: 0,
  });
  const delta = framePicture(frame({ codec: "h264", keyframe: false }));
  expect(delta).toMatchObject({ key: false, codecNamed: false });
  // Every JPEG stands alone.
  expect(framePicture(frame()).key).toBe(true);
});
