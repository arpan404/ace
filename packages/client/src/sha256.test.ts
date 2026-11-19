import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { Sha256 } from "./sha256.ts";

const expected = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a hash fed in parts of any size matches hashing the bytes whole", () => {
  const bytes = new Uint8Array(70_000).map((_, index) => (index * 31 + (index >> 7)) & 0xff);
  for (const size of [1, 3, 55, 56, 63, 64, 65, 4096, 65_536, 70_000]) {
    const hash = new Sha256();
    for (let at = 0; at < bytes.length; at += size) hash.update(bytes.subarray(at, at + size));
    expect(hash.hex(), `parts of ${size}`).toBe(expected(bytes));
  }
});

test("lengths around a block's padding boundary hash as the standard says", () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 119, 120, 128]) {
    const bytes = new Uint8Array(length).fill(0x61);
    expect(new Sha256().update(bytes).hex(), `${length} bytes`).toBe(expected(bytes));
  }
});
