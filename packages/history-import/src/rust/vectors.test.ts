import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { FrameReader, encodeFrames } from "./frames.ts";
import { historyVectors } from "./vectors.ts";

const dir = new URL("../../../../native/history/vectors/", import.meta.url);

test("the shared vectors ace-history is tested against are generated from this TypeScript", async () => {
  for (const [name, content] of Object.entries(historyVectors()))
    // Compared parsed: the formatter may lay a file out its own way.
    expect(
      JSON.parse(await readFile(new URL(name, dir), "utf8")),
      `${name} is stale: run scripts/vectors.ts`,
    ).toEqual(JSON.parse(JSON.stringify(content)));
});

test("frames ace-history writes read back as the worker's messages, bodies as bytes", () => {
  const reader = new FrameReader();
  const [body, json] = encodeFrames(
    { id: 9, value: { bytes: new Uint8Array([9, 8, 7]), size: 3 } },
    9,
  );
  if (!body || !json) throw new Error("expected two frames");
  const joined = new Uint8Array([...body, ...json]);
  // Split anywhere: a pipe may hand over half a frame.
  reader.push(joined.subarray(0, 7));
  expect([...reader.messages()]).toEqual([]);
  reader.push(joined.subarray(7));
  expect([...reader.messages()]).toEqual([
    { id: 9, value: { bytes: new Uint8Array([9, 8, 7]), size: 3 } },
  ]);
});

test("a broken frame declaration is an error, never a message", () => {
  const reader = new FrameReader();
  reader.push(new Uint8Array([0, 0, 0, 0]));
  expect(() => [...reader.messages()]).toThrow("frame declares no kind byte");
  const oversized = new FrameReader();
  oversized.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  expect(() => [...oversized.messages()]).toThrow("exceeds the 16 MiB limit");
});

test("a Buffer travels as a body, not as its JSON form", () => {
  const reader = new FrameReader();
  for (const frame of encodeFrames({ id: 2, request: { bytes: Buffer.from([1, 2, 3]) } }, 2))
    reader.push(frame);
  const [message] = [...reader.messages()];
  expect(message).toEqual({ id: 2, request: { bytes: new Uint8Array([1, 2, 3]) } });
});
