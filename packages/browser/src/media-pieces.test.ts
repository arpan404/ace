import { expect, test } from "vitest";
import { encodeStream, StreamAssembler, streamKinds } from "./stream-envelope.ts";

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
