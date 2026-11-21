import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { FrameReader, encodeFrames } from "./frames.ts";
import { historyVectors } from "./vectors.ts";

const dir = new URL("../../../../native/history/vectors/", import.meta.url);

test("the shared vectors ace-history is tested against are generated from this TypeScript", async () => {
  for (const [name, content] of Object.entries(historyVectors()))
    expect(
      await readFile(new URL(name, dir), "utf8"),
      `${name} is stale: run scripts/vectors.ts`,
    ).toBe(JSON.stringify(content, null, 2) + "\n");
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

test("a broken frame declaration ends the stream", () => {
  const reader = new FrameReader();
  reader.push(new Uint8Array([0, 0, 0, 0]));
  expect(() => [...reader.messages()]).toThrow("broken frame");
});
