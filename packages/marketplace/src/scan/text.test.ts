import { describe, expect, it } from "vitest";
import { fold, hasBidi, hasInvisible, mixedScriptWord, normaliseText } from "./text.ts";

/*
 * Text folding (ADR 0173 §8): look-alikes folded, zero-width and bidi characters told apart from
 * ordinary text, and an emoji joiner allowed between emoji. These guard the hidden check and the
 * profile rules.
 */

describe("hasInvisible", () => {
  it.each([
    ["plain ASCII", "curl https://example.com", false],
    ["ordinary prose with punctuation", "It's a fine day — really.", false],
    ["a zero-width space", "cu​rl", true],
    ["a zero-width joiner between letters", "a‍b", true],
    ["a tag character", "x\u{E0041}y", true],
    ["an emoji joiner between emoji", "\u{1F469}‍\u{1F4BB}", false],
  ])("on %s", (_name, text, expected) => {
    expect(hasInvisible(text)).toBe(expected);
  });
});

describe("hasBidi", () => {
  it("finds a right-to-left override", () => {
    expect(hasBidi("file‮gnp.js")).toBe(true);
  });
  it("passes plain text", () => {
    expect(hasBidi("file.js")).toBe(false);
  });
});

describe("mixedScriptWord", () => {
  it("flags a word mixing Latin and Cyrillic", () => {
    expect(mixedScriptWord("pаypal")).toBeTruthy();
  });
  it("passes a single-script word and a mixed sentence of single-script words", () => {
    expect(mixedScriptWord("paypal")).toBeUndefined();
    expect(mixedScriptWord("Tokyo 東京 studio")).toBeUndefined();
  });
});

describe("fold", () => {
  it("folds a Cyrillic look-alike to Latin and records it", () => {
    const folded = fold("сurl"); // Cyrillic es + "url"
    expect(folded.text).toBe("curl");
    expect(folded.lookalike).toBe(true);
  });
  it("leaves ordinary text untouched", () => {
    const folded = fold("curl");
    expect(folded.text).toBe("curl");
    expect(folded.lookalike).toBe(false);
  });
});

describe("normaliseText", () => {
  it("removes zero-width characters and applies NFKC", () => {
    expect(normaliseText("cu​rl")).toBe("curl");
    expect(normaliseText("ｃurl")).toBe("curl"); // full-width c
  });
});
