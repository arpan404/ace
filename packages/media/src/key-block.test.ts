import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { crc32c, decodeKeyBlock, encodeKeyBlock } from "./key-block.ts";
const fixture = z
  .object({ hex: z.string() })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../native/media/vectors/key-block/contracts.json", import.meta.url),
        "utf8",
      ),
    ),
  );
test("shared key block keeps full u64 counters and catches corruption", () => {
  expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  const bytes = new Uint8Array(Buffer.from(fixture.hex, "hex")),
    block = decodeKeyBlock(bytes);
  expect(block).toEqual({
    sendKey: Uint8Array.from({ length: 32 }, (_, i) => i),
    receiveKey: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
    sendNonce: 0x123456789abcdef0n,
    receiveNonce: 0xffffffffffffffffn,
    framesSent: 1048575n,
    framesReceived: 1048576n,
    flags: 3,
    window: 1048576,
    unacked: 4096,
    owed: 4096,
    uncounted: 0,
  });
  expect(block.sendNonce).toBe(0x123456789abcdef0n);
  expect(block.receiveNonce).toBe(0xffffffffffffffffn);
  const encoded = new Uint8Array(120);
  encodeKeyBlock(block, encoded);
  expect(encoded).toEqual(bytes);
  for (let i = 0; i < 120; i++) {
    const bad = bytes.slice();
    bad[i] = (bad[i] ?? 0) ^ 1;
    expect(() => decodeKeyBlock(bad)).toThrow();
  }
  for (let n = 0; n < 120; n++) expect(() => decodeKeyBlock(bytes.subarray(0, n))).toThrow();
  bytes.fill(0);
  expect([...block.sendKey, ...block.receiveKey].every((b) => b === 0)).toBe(true);
});
test("reserved bytes and unknown flow flags are refused even with a correct CRC", () => {
  for (const [at, value] of [
    [96, 4],
    [97, 1],
    [98, 1],
    [99, 1],
  ] as const) {
    const b = new Uint8Array(Buffer.from(fixture.hex, "hex"));
    b[at] = value;
    new DataView(b.buffer).setUint32(116, crc32c(b.subarray(0, 116)));
    expect(() => decodeKeyBlock(b)).toThrow();
  }
});
