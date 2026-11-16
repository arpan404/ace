import { deriveAccent } from "./accent-fit.ts";
import { parseOpaqueColor } from "./colour.ts";
import { schemePalette, themeSources, type ThemeId } from "./palettes.ts";
import type { GlassMaterial, Palette, Scheme, SchemeSource, Syntax } from "./types.ts";

/*
 * A palette someone else designed (a Suit, ADR 0150) laid over a built-in theme's source. Only
 * the neutral ramp, code, accent, diff, syntax and glass can change: status hues are the base
 * theme's, never the override's, so an agent's state reads the same in every look. The result
 * goes through the same fitting as the built-in themes (`schemePalette`).
 */

/** The fields a custom palette may set. Anything else on the input is ignored. */
export const customColourFields = [
  "canvas",
  "sidebar",
  "surface",
  "raised",
  "hover",
  "active",
  "border",
  "borderStrong",
  "faint",
  "subtle",
  "muted",
  "text",
  "code",
  "accent",
  "accentHover",
  "accentFg",
  "accentText",
  "diffAdd",
  "diffAddFg",
  "diffDel",
  "diffDelFg",
] as const satisfies readonly (keyof SchemeSource)[];
export type CustomColourField = (typeof customColourFields)[number];

const syntaxFields = ["kw", "fn", "str", "num", "type", "com", "punc"] as const;

export type CustomScheme = { [K in CustomColourField]?: string | undefined } & {
  syntax?: { [K in keyof Syntax]?: string | undefined } | undefined;
  /** Frosted glass; null keeps floating layers solid; unset keeps the base theme's. */
  glass?: GlassMaterial | null | undefined;
};

const colour = (value: unknown): string | undefined =>
  typeof value === "string" && parseOpaqueColor(value) ? value : undefined;

function pick<K extends string>(
  keys: readonly K[],
  from: Partial<Record<K, unknown>> | undefined,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (!from) return out;
  for (const key of keys) {
    const value = colour(from[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** One scheme of `base` with `overrides` laid over it, fitted like a built-in theme. */
export function customPalette(base: ThemeId, scheme: Scheme, overrides: CustomScheme): Palette {
  const theme = themeSources[base];
  const source = theme[scheme];
  const colours = pick(customColourFields, overrides);
  const merged: SchemeSource = {
    ...source,
    ...colours,
    syntax: { ...source.syntax, ...pick(syntaxFields, overrides.syntax) },
  };
  const baseMaterial = theme.material[scheme];
  const material =
    overrides.glass === undefined ? baseMaterial : { ...baseMaterial, glass: overrides.glass };
  // An accent given without its hover, label and link takes the missing ones as the accent
  // picker fits them to these surfaces; any the palette gives are kept as given.
  const { accent, accentHover, accentFg, accentText } = colours;
  if (
    accent === undefined ||
    (accentHover !== undefined && accentFg !== undefined && accentText !== undefined)
  )
    return schemePalette(merged, scheme, material);
  const fitted = deriveAccent(accent, scheme, schemePalette(merged, scheme, material));
  return schemePalette(
    {
      ...merged,
      accent: fitted.accent,
      accentHover: accentHover ?? fitted.accentHover,
      accentFg: accentFg ?? fitted.accentFg,
      accentText: accentText ?? fitted.accentText,
    },
    scheme,
    material,
  );
}
