import { expect, test } from "vitest";
import { withoutNonWoff2 } from "./katex-woff2.ts";

const face =
  "@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:400;" +
  'src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),' +
  'url(fonts/KaTeX_Main-Regular.woff) format("woff"),' +
  'url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}';

test("only woff2 survives, and a blocking display becomes a swap", () => {
  const css = withoutNonWoff2(`${face}.katex{font:400 1.21em KaTeX_Main}`);
  expect(css).toContain('url(fonts/KaTeX_Main-Regular.woff2) format("woff2")');
  expect(css).not.toContain('format("woff")');
  expect(css).not.toContain(".ttf");
  expect(css).not.toContain("font-display:block");
  expect(css).toContain("font-display:swap");
  expect(css).toContain(".katex{font:400 1.21em KaTeX_Main}");
});

test("css without legacy formats passes through untouched", () => {
  const css = ".katex{color:inherit}";
  expect(withoutNonWoff2(css)).toBe(css);
});
