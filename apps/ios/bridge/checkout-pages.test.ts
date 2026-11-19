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

  it.each([
    ["an accent that may follow in the next part", "aaaae", "aaaa"],
    ["a letter and its combining accent", "aaaae\u0301", "aaaa"],
    ["an emoji joined with ZWJ", "aaaa👩\u200d💻", "aaaa"],
    ["a flag's two regional indicators", "aaaa🇳🇵", "aaaa"],
  ])("ends a page longer than a line before its last cluster: %s", (_, text, page) => {
    const part = bytes(text);
    expect(new TextDecoder().decode(part.subarray(0, pageEnd(part, false)))).toBe(page);
  });

  it("the next page starts with a whole cluster, so its accent stays with its letter", () => {
    const file = bytes(`${"a".repeat(10)}e\u0301${"b".repeat(5)}`);
    const first = file.subarray(0, 11); // the read stops between "e" and its accent
    const end = pageEnd(first, false);
    expect(new TextDecoder().decode(file.subarray(end, end + 3))).toBe("e\u0301");
  });

  it("never splits a character when one line is longer than a page", () => {
    const part = bytes("aaaa漢字字").subarray(0, 11); // cuts inside the second 字
    const end = pageEnd(part, false);
    // The cut character goes to the next page, and so does the whole one before it, which a
    // combining mark in the next page could still belong to.
    expect(new TextDecoder("utf-8", { fatal: true }).decode(part.subarray(0, end))).toBe("aaaa漢");
  });
});
