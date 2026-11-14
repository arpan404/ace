import { expect, it } from "vitest";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import { FrameDecoder, framePacket, type Frame } from "./frames.ts";
import { egressScreenFrame } from "./media-source.ts";

const annexB = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x33, 0, 0, 0, 1, 0x65, 0x88]);

/** What the helper's socket carries for one keyframe today. */
function fromHelperSocket(): Frame {
  const frames: Frame[] = [];
  new FrameDecoder((frame) => void frames.push(frame)).push(
    framePacket(
      {
        version: 2,
        sessionId: "s1",
        seq: 41,
        ts: 1_763_000_000_123.5,
        width: 1280,
        height: 800,
        scale: 1.7777,
        codec: "h264",
        keyframe: true,
        videoCodec: "avc1.640033",
        bytes: annexB.length,
      },
      annexB,
    ),
  );
  const [frame] = frames;
  if (!frame) throw new Error("no frame");
  return frame;
}

it("an egress unit becomes the frame the helper socket carries, header and packet alike", () => {
  const frame = egressScreenFrame("s1", {
    kind: 1,
    flags: 1,
    ageUs: 1500,
    width: 1280,
    height: 800,
    displayWidth: 720,
    displayHeight: 450,
    scale: 1778,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: "avc1.640033",
    description: new Uint8Array(0),
    extension: encodeProducerStamp({ sequence: 41, timestamp: 1_763_000_000_123.5, scale: 1.7777 }),
    payload: new Uint8Array(annexB),
  });
  const expected = fromHelperSocket();
  expect(frame?.header).toEqual(expected.header);
  expect(frame?.payload).toEqual(expected.payload);
  expect(frame?.packet).toEqual(expected.packet);
});

it("an egress unit without the helper's stamp, or not H.264, is no screen frame", () => {
  const base = {
    kind: 1,
    flags: 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array(annexB),
  };
  expect(egressScreenFrame("s1", base)).toBeUndefined();
  const stamped = {
    ...base,
    extension: encodeProducerStamp({ sequence: 1, timestamp: 1, scale: 1 }),
  };
  expect(egressScreenFrame("s1", { ...stamped, codec: 7 })).toBeUndefined();
  expect(egressScreenFrame("s1", stamped)?.header.keyframe).toBe(false);
});
