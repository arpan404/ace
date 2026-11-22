import { expect, test } from "vitest";
import { cssFont } from "./css-font.ts";

/*
 * The font to measure text in, from an element's computed style. Chromium reports the `font`
 * shorthand empty when the font sets features or variants (a Suit's code font does), so the
 * font is rebuilt from its parts; measuring in "" would use the browser's default font.
 */
const style = (font: string) => ({
  font,
  fontStyle: "normal",
  fontWeight: "400",
  fontSize: "13px",
  fontFamily: 'ace-suit-tarn-mono, "SF Mono", monospace',
});

test.each([
  ["a reported shorthand is used as is", style("400 13px Inter"), "400 13px Inter"],
  [
    "an empty shorthand is rebuilt from its parts",
    style(""),
    'normal 400 13px ace-suit-tarn-mono, "SF Mono", monospace',
  ],
] as const)("%s", (_name, computed, font) => {
  expect(cssFont(computed)).toBe(font);
});
