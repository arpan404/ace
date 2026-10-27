import { describe, expect, it } from "vitest";
import { pageEnd } from "./checkout-pages.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("reading a large file a page at a time", () => {
  it("ends a page after its last whole line", () => {
    const part = bytes("one\ntwo\nthr");
    expect(new TextDecoder().decode(part.subarray(0, pageEnd(part, false)))).toBe("one\ntwo\n");
  });

  it("keeps the whole part at the end of the file", () => {
    const part = bytes("one\ntail without break");
    expect(pageEnd(part, true)).toBe(part.length);
  });

  it("never splits a character when one line is longer than a page", () => {
    const part = bytes("aaaa漢字").subarray(0, 8); // cuts inside 字
    const end = pageEnd(part, false);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(part.subarray(0, end))).toBe("aaaa漢");
  });
});
