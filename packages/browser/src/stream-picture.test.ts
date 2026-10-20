import { describe, expect, it } from "vitest";
import {
  decodeStreamMessage,
  encodeBrowserVideo,
  encodePicture,
  StreamAssembler,
  StreamEnvelopeError,
  streamPieceBytes,
  type PictureChunk,
  type StreamMessage,
} from "./stream.ts";
import { encodeStream, streamKinds } from "./stream-envelope.ts";

const encodeDeviceFrame = (
  id: number,
  source: string,
  chunk: Omit<PictureChunk, "bytes">,
  payload: Uint8Array,
) => encodePicture(streamKinds.deviceFrame, id, source, chunk, payload);

const device = "android:emulator-5554";
const header = {
  sequence: 41,
  timestamp: 1_700_000_000_250,
  width: 1080,
  height: 2400,
  scale: 0.375,
  rotation: 0 as const,
  codec: "avc1.640028",
  key: true,
  streamId: "capture-1",
};
const bytes = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index * 13) % 256);

function receive(pieces: readonly Uint8Array[]): StreamMessage[] {
  const assembler = new StreamAssembler();
  return pieces.flatMap((piece) => {
    const envelope = assembler.push(piece);
    const message = envelope && decodeStreamMessage(envelope);
    return message ? [message] : [];
  });
}

describe("pictures on the shared stream", () => {
  it("an H.264 keyframe larger than a socket message arrives whole, naming its device", () => {
    const payload = bytes(300_000);
    const pieces = encodeDeviceFrame(7, device, header, payload);
    expect(pieces.length).toBeGreaterThan(4);
    expect(pieces.every((piece) => piece.length <= streamPieceBytes)).toBe(true);
    const [message] = receive(pieces);
    expect(message).toEqual({
      kind: "device.frame",
      sourceId: device,
      frame: { ...header, bytes: payload },
    });
  });

  it("a landscape iOS JPEG keeps its rotation and scale, and counts as a keyframe", () => {
    const frame = {
      ...header,
      codec: "jpeg",
      key: false,
      rotation: 90 as const,
      scale: 1 / 3,
      width: 390,
      height: 844,
    };
    const [message] = receive(
      encodeDeviceFrame(1, "ios:0E6C8A44-4A84-4A06-9C7A-8F0A8F1B6C11", frame, bytes(2048)),
    );
    expect(message?.kind).toBe("device.frame");
    if (message?.kind !== "device.frame") return;
    expect(message.frame.rotation).toBe(90);
    expect(message.frame.key).toBe(true);
    expect(message.frame.scale).toBeCloseTo(1 / 3, 6);
  });

  it("device pictures and browser video interleave on one connection without mixing", () => {
    const video = encodeBrowserVideo(
      2,
      "thread-1",
      {
        sequence: 1,
        timestamp: 5,
        width: 800,
        height: 600,
        codedWidth: 800,
        codedHeight: 600,
        codec: "avc1.42E033",
        key: true,
      },
      bytes(70_000),
    );
    const picture = encodeDeviceFrame(3, device, { ...header, key: false }, bytes(90_000));
    const kinds = receive([...video, ...picture]).map((message) => message.kind);
    expect(kinds).toEqual(["browser.video", "device.frame"]);
  });

  it("refuses a header that names no device, an unknown codec or an odd rotation", () => {
    const assembler = new StreamAssembler();
    const decode = (pieces: Uint8Array[]) => {
      const envelope = pieces.map((piece) => assembler.push(piece)).at(-1);
      return envelope && decodeStreamMessage(envelope);
    };
    expect(() => decode(encodeDeviceFrame(1, "not a device", header, bytes(10)))).toThrow(
      StreamEnvelopeError,
    );
    expect(() =>
      decode(encodeDeviceFrame(2, device, { ...header, codec: "vp8" }, bytes(10))),
    ).toThrow(StreamEnvelopeError);
    const odd = encodeDeviceFrame(3, device, header, bytes(10));
    new DataView(odd[0]!.buffer).setUint16(20 + 24, 45);
    expect(() => decode(odd)).toThrow(StreamEnvelopeError);
    const short = encodeStream(streamKinds.deviceFrame, 4, new Uint8Array(12), bytes(10));
    expect(() => decode(short)).toThrow(StreamEnvelopeError);
  });

  it("a computer-use picture names its screen session, a different kind from a device's", () => {
    const pieces = encodePicture(streamKinds.screenFrame, 9, "session-1", header, bytes(4096));
    const [message] = receive(pieces);
    expect(message?.kind).toBe("screen.frame");
    if (message?.kind !== "screen.frame") return;
    expect(message.sourceId).toBe("session-1");
    expect(message.frame.codec).toBe("avc1.640028");
    // A screen session id is not a device id, so the device kind refuses it.
    expect(() => receive(encodeDeviceFrame(10, "session-1", header, bytes(10)))).toThrow(
      StreamEnvelopeError,
    );
  });

  it("a screenshot travels as a still picture, so no viewer acks it", () => {
    const shot = { ...header, codec: "jpeg", still: true as const };
    const [still] = receive(encodeDeviceFrame(11, device, shot, bytes(512)));
    const [live] = receive(encodeDeviceFrame(12, device, { ...header, codec: "jpeg" }, bytes(512)));
    expect(still?.kind === "device.frame" && still.frame.still).toBe(true);
    expect(live?.kind === "device.frame" && live.frame.still).toBeUndefined();
  });
});
