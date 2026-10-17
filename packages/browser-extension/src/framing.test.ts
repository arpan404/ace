import { expect, test } from "vitest";
import { encodeNativeMessage, NativeMessageDecoder, NativeMessageTooLarge } from "./framing.ts";

test("a message survives encoding and decoding with a little-endian length prefix", () => {
  const frame = encodeNativeMessage({ type: "ping", text: "héllo" }, 1024);
  expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
  expect(new NativeMessageDecoder(1024).push(frame)).toEqual([{ type: "ping", text: "héllo" }]);
});

test("frames split across chunks and joined in one chunk all decode in order", () => {
  const first = encodeNativeMessage({ n: 1 }, 1024);
  const second = encodeNativeMessage({ n: 2, padding: "x".repeat(300) }, 1024);
  const third = encodeNativeMessage({ n: 3 }, 1024);
  const stream = Buffer.concat([first, second, third]);
  const decoder = new NativeMessageDecoder(1024);
  const seen: unknown[] = [];
  // One byte at a time, then the rest at once: every boundary lands mid-header or mid-body.
  for (let index = 0; index < 40; index++)
    seen.push(...decoder.push(stream.subarray(index, index + 1)));
  seen.push(...decoder.push(stream.subarray(40)));
  expect(seen).toEqual([{ n: 1 }, { n: 2, padding: "x".repeat(300) }, { n: 3 }]);
});

test("a frame that is not JSON is skipped and the next frame still decodes", () => {
  const garbage = Buffer.from("not json");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(garbage.length, 0);
  const decoder = new NativeMessageDecoder(1024);
  expect(
    decoder.push(Buffer.concat([header, garbage, encodeNativeMessage({ ok: true }, 1024)])),
  ).toEqual([{ ok: true }]);
});

test("a message over Chrome's limit is refused before it reaches the port", () => {
  expect(() => encodeNativeMessage({ data: "x".repeat(2048) }, 1024)).toThrow(
    NativeMessageTooLarge,
  );
});

test("a declared length over the limit fails the stream instead of buffering it", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(4096, 0);
  expect(() => new NativeMessageDecoder(1024).push(header)).toThrow(NativeMessageTooLarge);
});
