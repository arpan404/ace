import { forkTheme, withToken } from "@/theme/custom-themes.ts";
import { basePreset, presetTheme, type Theme } from "@/theme/presets.ts";
import type { TokenName } from "@/theme/tokens.ts";

/**
 * Custom theme ids carry the preset they came from ("dark~3f9a2c"), so "Reset to Dark" works
 * for forks, duplicates of forks and themes exported and imported again, with no extra store.
 */
export function customThemeId(base: Theme, suffix: string): string {
  return `${base.id}~${suffix}`;
}

/** The preset a custom theme resets to: the one it was forked from, else its scheme's base. */
export function baseOf(theme: Theme): Theme {
  if (theme.preset) return theme;
  return presetTheme(theme.id.split("~")[0] ?? "") ?? basePreset(theme.scheme);
}

export interface Edit {
  theme: Theme;
  /** Set when the edit forked a read-only preset into a new custom theme. */
  forked: boolean;
}

/** Apply one token edit. Presets are never changed: the first edit forks a copy. */
export function editToken(theme: Theme, token: TokenName, value: string, suffix: string): Edit {
  if (!theme.preset) return { theme: withToken(theme, token, value), forked: false };
  const copy = forkTheme(theme, customThemeId(theme, suffix), `${theme.name} custom`);
  return { theme: withToken(copy, token, value), forked: true };
}

/** A copy of any theme, named "<name> copy", that keeps the source's preset lineage. */
export function duplicateTheme(theme: Theme, suffix: string): Theme {
  return forkTheme(theme, customThemeId(baseOf(theme), suffix));
}

/** The custom theme with its preset's tokens again; id and name are kept. */
export function resetTheme(theme: Theme): Theme {
  const base = baseOf(theme);
  return { ...theme, scheme: base.scheme, tokens: { ...base.tokens } };
}

const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const triple = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/;
const colourFunction = /^(rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\(/i;

export function isHexColor(value: string): boolean {
  return hex.test(value.trim());
}

/** #abc → #aabbcc, the only form <input type="color"> accepts. */
export function longHex(value: string): string {
  const text = value.trim();
  if (text.length !== 4) return text.toLowerCase();
  return `#${Array.from(text.slice(1), (c) => c + c).join("")}`.toLowerCase();
}

/** What the swatch paints: colours as they are, "r g b" triples as rgb(); nothing otherwise. */
export function swatchColor(value: string): string | undefined {
  const text = value.trim();
  if (hex.test(text) || colourFunction.test(text)) return text;
  if (triple.test(text)) return `rgb(${text})`;
  return undefined;
}
