import { expect, test } from "vitest";
import { parseOpaqueColor, rgbToOklch } from "./colour.ts";
import { themeIds, themes } from "./palettes.ts";
import { tintedLike } from "./surface-tint.ts";

const lch = (hex: string) => {
  const rgb = parseOpaqueColor(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  return rgbToOklch(rgb);
};

test("in every theme and scheme, a raised surface is the canvas's own colour, lifted or level", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const { s0, s2 } = themes[id][scheme];
      const [canvas, raised] = [lch(s0), lch(s2)];
      // Never a neutral sheet over a tinted page: the same chroma, within 8-bit rounding.
      expect([id, scheme, Math.abs(raised.c - canvas.c) < 0.0025]).toEqual([id, scheme, true]);
      if (canvas.c > 0.005)
        expect([id, scheme, Math.abs(raised.h - canvas.h) < 4]).toEqual([id, scheme, true]);
      // Raised sits off the canvas in the scheme's direction (or level, where sRGB tops out).
      const lift = scheme === "dark" ? raised.l - canvas.l : canvas.l - raised.l;
      expect([id, scheme, lift >= -0.001]).toEqual([id, scheme, true]);
    }
});

test("a surface keeps its lightness where sRGB holds the canvas's tint, else steps to the canvas", () => {
  // Dark: plenty of room, so the lift stays and the hue follows the canvas.
  const dark = lch(tintedLike("#191611", "#13100C"));
  expect(dark.l).toBeGreaterThan(lch("#13100C").l + 0.02);
  expect(Math.abs(dark.h - lch("#13100C").h)).toBeLessThan(3);
  // Light cream near white: no lighter colour holds that warmth, so it is the canvas.
  expect(tintedLike("#FFFCF7", "#FFFAF4")).toBe("#FFFAF4");
  // A neutral canvas leaves the surface as designed.
  expect(tintedLike("#121212", "#0C0C0C")).toBe("#121212");
});
