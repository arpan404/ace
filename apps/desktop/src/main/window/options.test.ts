import { expect, test } from "vitest";
import { captionSymbolColor, titleBarSymbolColor, windowOptions } from "./options.ts";

const darkGlyphs = titleBarSymbolColor(false);
const lightGlyphs = titleBarSymbolColor(true);

function windowsOverlay(osDark: boolean, background?: string) {
  const options = windowOptions({
    platform: "win32",
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
    preload: "preload.cjs",
    info: "{}",
    dark: osDark,
    background,
  });
  const overlay = options.titleBarOverlay;
  return typeof overlay === "object" ? overlay.symbolColor : undefined;
}

test("Windows caption buttons stay readable when the page's theme differs from the OS", () => {
  // A light page under a dark OS, and a dark page under a light one.
  expect(windowsOverlay(true, "#ffffff")).toBe(darkGlyphs);
  expect(windowsOverlay(false, "#0c0c0c")).toBe(lightGlyphs);
  // Before the page has said, the OS scheme decides.
  expect(windowsOverlay(true)).toBe(lightGlyphs);
  expect(windowsOverlay(false)).toBe(darkGlyphs);
});

test("caption glyphs follow the background's lightness, mid tones included", () => {
  expect(captionSymbolColor("#f4f4f5")).toBe(darkGlyphs);
  expect(captionSymbolColor("#1d1d20")).toBe(lightGlyphs);
  expect(captionSymbolColor("#2563eb")).toBe(lightGlyphs);
  expect(captionSymbolColor("#fbbf24")).toBe(darkGlyphs);
  // Not a hex colour: the OS scheme decides.
  expect(captionSymbolColor("transparent", true)).toBe(lightGlyphs);
});
