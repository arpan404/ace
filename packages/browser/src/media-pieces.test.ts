import { expect, test } from "vitest";
import { encodeStream, StreamAssembler, streamKinds } from "./stream-envelope.ts";
import { PictureViewer, type CapturedPicture } from "./picture-viewer.ts";

test("large media pieces each fit one encrypted relay fragment and reassemble unchanged", () => {
  const payload = new Uint8Array(300_000).fill(37);
  const pieces = encodeStream(2, 7, new Uint8Array(80), payload);
  const assembler = new StreamAssembler();
  let result;
  for (const piece of pieces) {
    expect(piece.length + 1 + 16).toBeLessThanOrEqual(65_535);
    result = assembler.push(piece);
  }
  expect(result?.payload).toEqual(payload);
});

test("viewers share immutable pieces for the same captured picture", () => {
  const picture: CapturedPicture = {
    sequence: 1,
    timestamp: 1,
    width: 640,
    height: 400,
    scale: 1,
    rotation: 0,
    codec: "avc1.42E033",
    codecNamed: true,
    key: true,
    streamId: "capture",
    bytes: new Uint8Array(100_000).fill(19),
  };
  const received: Uint8Array[][] = [];
  for (let n = 0; n < 2; n++) {
    const viewer = new PictureViewer(streamKinds.screenFrame, "screen", {
      now: () => 0,
      after: () => () => {},
      messageId: () => n + 1,
      keyframe: () => {},
      write: (pieces) => {
        received.push(pieces);
        return true;
      },
    });
    viewer.push(picture);
  }
  expect(received).toHaveLength(2);
  expect(received[0] === received[1]).toBe(true);
  const assembler = new StreamAssembler();
  let decoded;
  for (const piece of received[1] ?? []) decoded = assembler.push(piece);
  expect(decoded?.payload).toEqual(picture.bytes);
});
