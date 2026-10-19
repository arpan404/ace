import { Marked } from "marked";
import { expect, test } from "vitest";
import type { MarkdownBlock } from "./blocks.ts";
import { isMathToken, mathExtension } from "./math-extension.ts";
import { renderSettledMath } from "./math-worker.ts";

/** Blocks lexed the way the worker lexes them, carrying real math tokens. */
const lexBlocks = (text: string): MarkdownBlock[] => {
  const marked = new Marked();
  marked.use({ extensions: [mathExtension] });
  return marked.lexer(text).map((token) => ({ token }));
};

const mathHtml = (blocks: MarkdownBlock[]): unknown => {
  const token = blocks[0]?.token;
  const math = token?.type === "paragraph" ? token.tokens?.find(isMathToken) : undefined;
  return math?.html;
};

test("settled formulas gain HTML the page can insert directly", async () => {
  const blocks = lexBlocks("Mean \\(\\mu\\).");
  expect(await renderSettledMath(blocks)).toBe(1);
  const html = mathHtml(blocks);
  expect(typeof html === "string" && (html as string).includes("katex")).toBe(true);
});

test("a repeated formula renders once and reuses its HTML", async () => {
  const first = lexBlocks("See \\(x\\).");
  const second = lexBlocks("See \\(x\\).");
  expect(await renderSettledMath(first)).toBe(1);
  expect(await renderSettledMath(second)).toBe(1);
  expect(mathHtml(first)).toBe(mathHtml(second));
});

test("invalid TeX gains no HTML and never throws", async () => {
  const blocks = lexBlocks("See \\(\\unknowncommand{\\).");
  expect(await renderSettledMath(blocks)).toBe(0);
  expect(mathHtml(blocks)).toBeUndefined();
});

test("messages without math do no KaTeX work", async () => {
  expect(await renderSettledMath(lexBlocks("Plain."))).toBe(0);
});
