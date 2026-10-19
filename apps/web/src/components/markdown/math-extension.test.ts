import { Marked } from "marked";
import { expect, test } from "vitest";
import {
  collectUnrenderedMath,
  hasMathDelimiter,
  isMathToken,
  mathExtension,
} from "./math-extension.ts";

const lex = (text: string) => {
  const marked = new Marked();
  marked.use({ extensions: [mathExtension] });
  return marked.lexer(text);
};

test("an opener with no closer shows as pending text, not an escape", () => {
  const [paragraph] = lex("Result \\[ x+1");
  const math = paragraph?.type === "paragraph" ? paragraph.tokens?.find(isMathToken) : undefined;
  expect(math?.pending).toBe(true);
  expect(math?.raw).toBe("\\[");
});

test("currency never lexes as math", () => {
  const [paragraph] = lex("It costs $5 and $10 total");
  const tokens = paragraph?.type === "paragraph" ? (paragraph.tokens ?? []) : [];
  expect(tokens.some(isMathToken)).toBe(false);
});

test("math inside code spans and fences never lexes as math", () => {
  const blocks = lex("Use `$x$` here.\n\n```\n\\(z\\)\n```\n");
  expect(collectUnrenderedMath(blocks)).toHaveLength(0);
});

test("the delimiter signal fires on math openers only", () => {
  expect(hasMathDelimiter("Result \\[ x+1")).toBe(true);
  expect(hasMathDelimiter("$x$")).toBe(true);
  expect(hasMathDelimiter("It costs $5")).toBe(true);
  expect(hasMathDelimiter("plain text")).toBe(false);
  expect(hasMathDelimiter("")).toBe(false);
});

test("collection finds math in prose and skips pending and rendered spans", () => {
  const blocks = lex("Mean \\(\\mu\\).\n\n\\[ z=1 \\]\n");
  const found = collectUnrenderedMath(blocks);
  expect(found.map((span) => span.tex)).toEqual(["\\mu", " z=1 "]);
  expect(found.every((span) => span.html === undefined)).toBe(true);
  const first = found[0];
  if (!first) throw new Error("Expected a math span");
  first.html = "<span>cached</span>";
  expect(collectUnrenderedMath(blocks).map((span) => span.tex)).toEqual([" z=1 "]);
});
