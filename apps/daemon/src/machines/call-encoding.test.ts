import { expect, test } from "vitest";
import { decodeBody, encodeBody, pickEncoding } from "./call-encoding.ts";

test("zstd is chosen when the other side offers it, deflate when only that, identity otherwise", () => {
  expect(pickEncoding("zstd, deflate")).toBe("zstd");
  expect(pickEncoding("gzip, deflate")).toBe("deflate");
  expect(pickEncoding("gzip, br")).toBeUndefined();
  expect(pickEncoding(undefined)).toBeUndefined();
});

test("a coding the other side refuses with q=0 is never used", () => {
  expect(pickEncoding("zstd;q=0, deflate")).toBe("deflate");
  expect(pickEncoding("*;q=0")).toBeUndefined();
});

test("a body compressed either way reads back as sent", () => {
  const body = Buffer.from(
    JSON.stringify({ threads: Array.from({ length: 200 }, () => ({ state: "working" })) }),
  );
  for (const coding of ["zstd", "deflate"] as const) {
    const sent = encodeBody(body, coding);
    expect(sent.length).toBeLessThan(body.length / 4);
    expect(decodeBody(sent, coding, 1024 * 1024).equals(body)).toBe(true);
  }
});

test("a compressed body that would expand past the limit is refused, not read", () => {
  const bomb = Buffer.alloc(4 * 1024 * 1024, 0x20);
  for (const coding of ["zstd", "deflate"] as const)
    expect(() => decodeBody(encodeBody(bomb, coding), coding, 1024 * 1024)).toThrow();
  expect(() => decodeBody(Buffer.from("{}"), "br", 1024)).toThrow();
});
