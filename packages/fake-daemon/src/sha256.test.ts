import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { base64Bytes, sha256Hex } from "./sha256.ts";

test("the fake's hash is SHA-256, across block boundaries", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 37) % 256);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  expect([...base64Bytes(`data:text/plain;base64,${btoa("hi")}`)]).toEqual([104, 105]);
});
