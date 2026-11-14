import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { decodeMediaFrame, encodeMediaFrame, decodeEgress, encodeEgress } from "./frame.ts";
const fixtures = z
  .array(z.object({ kind: z.number(), hex: z.string(), egressHex: z.string() }))
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../native/media/vectors/frame/contracts.json", import.meta.url),
        "utf8",
      ),
    ),
  );
test("shared frames preserve codec descriptions, extensions, epochs and source handles", () => {
  for (const f of fixtures) {
    const bytes = new Uint8Array(Buffer.from(f.hex, "hex")),
      frame = decodeMediaFrame(bytes);
    expect(frame).toEqual({
      kind: f.kind,
      flags: 0x80000005,
      ageUs: 123456,
      width: 1920,
      height: 1080,
      displayWidth: 960,
      displayHeight: 540,
      scale: 2000,
      rotation: 1,
      codec: f.kind === 5 ? 0 : 2,
      encode: 99,
      epoch: 42,
      codecString: "avc1.640028",
      description: new Uint8Array([1, 100, 0, 40]),
      extension: new Uint8Array([200, 201]),
      payload: f.kind === 5 ? new Uint8Array(32).fill(7) : new Uint8Array([0, 1, 2, 255]),
    });
    expect(frame.epoch).toBe(42);
    expect(frame.flags).toBe(0x80000005);
    expect([...frame.extension]).toEqual([200, 201]);
    expect(encodeMediaFrame(frame)).toEqual(bytes);
    const e = new Uint8Array(Buffer.from(f.egressHex, "hex")),
      egress = decodeEgress(e);
    expect(egress).toEqual({ handle: 0x12345678, sequence: 0xffffffff, frame });
    expect(encodeEgress(egress.handle, egress.sequence, egress.frame)).toEqual(e);
    for (let n = 0; n < bytes.length; n++)
      expect(() => decodeMediaFrame(bytes.subarray(0, n))).toThrow();
    for (const [offset, replacement] of [
      [0, [0]],
      [4, [2]],
      [5, [0]],
      [6, [0, 43]],
      [6, [16, 1]],
      [8, [0, 128, 0, 1]],
      [40, [255, 255]],
      [30, [4]],
      [44, [255]],
    ] as const) {
      const bad = bytes.slice();
      bad.set(replacement, offset);
      expect(() => decodeMediaFrame(bad)).toThrow();
    }
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeMediaFrame(trailing)).toThrow();
  }
});
