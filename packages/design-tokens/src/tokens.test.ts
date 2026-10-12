import { describe, expect, it } from "vitest";
import rawTokens from "../tokens.json" with { type: "json" };
import { sharedStatus } from "../../../apps/web/src/theme/palettes.ts";
import { DesignTokensSchema, designTokens } from "./index.ts";

const schemes = ["light", "dark"] as const;
const surfaces = [
  "background",
  "secondaryBackground",
  "card",
  "fill",
  "glass",
  "needsYouSurface",
  "diffAdd",
  "diffDelete",
] as const;

// WCAG 2 relative luminance, with sRGB linearization. Evaluate unrounded ratios.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const sRGB = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : ((sRGB + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(text: string, surface: string): number {
  const a = luminance(text),
    b = luminance(surface);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("native theme data", () => {
  it("accepts the raw JSON consumed by native generators and produces the same TS theme", () => {
    expect(DesignTokensSchema.parse(rawTokens)).toEqual(designTokens);
  });

  for (const scheme of schemes) {
    // Web themes tune working, needs-you, done and failed per theme; waiting and not-responding
    // are shared by every web theme of a scheme, and native must render the same hues.
    it(`${scheme} waiting and not-responding markers match the colours the web renders`, () => {
      expect(designTokens.schemes[scheme].status).toMatchObject(sharedStatus[scheme]);
    });

    const theme = designTokens.schemes[scheme];
    const textColours = {
      foreground: theme.colours.foreground,
      mutedForeground: theme.colours.mutedForeground,
      subtleForeground: theme.colours.subtleForeground,
      accent: theme.colours.accent,
      ...Object.fromEntries(
        Object.entries(theme.statusText).map(([key, value]) => [`statusText.${key}`, value]),
      ),
    };
    for (const surface of surfaces) {
      for (const [name, colour] of Object.entries(textColours)) {
        it(`${scheme} ${name} remains readable as normal text on ${surface}`, () => {
          expect(contrast(colour, theme.colours[surface])).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${scheme} decorative glyphs remain distinguishable on ${surface}`, () => {
        expect(contrast(theme.colours.decoration, theme.colours[surface])).toBeGreaterThanOrEqual(
          3,
        );
      });
    }
    it(`${scheme} action text remains readable on the accent action surface`, () => {
      expect(contrast(theme.colours.onAccent, theme.colours.accent)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
