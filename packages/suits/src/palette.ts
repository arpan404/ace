import type { SuitBase, SuitManifest, SuitPalette } from "@ace/protocol/suits";
import {
  deriveAccent,
  schemePalette,
  themeSources,
  type Material,
  type Palette,
  type Scheme,
  type ThemeId,
} from "@ace/themes";

/*
 * A Suit's colours as a full palette: its base theme's source with the Suit's own colours laid
 * over it, built by the same `schemePalette` as the built-in themes. Only the fields below are
 * read from a Suit; status colours, the danger fill and everything else stay the base theme's
 * and the shared set's (ADR 0150), whatever extra keys the file carries.
 */

/** The built-in theme each base name starts from. */
export const suitBaseThemes: Record<SuitBase, ThemeId> = {
  graphite: "ace",
  midnight: "midnight",
  paper: "paper",
  slate: "harbor",
  aurora: "dusk",
  // No high-contrast theme ships yet; the graphite ramp has the widest contrast.
  contrast: "ace",
};

/** The colour fields a Suit may set, besides syntax and glass. */
export const suitColourFields = [
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
] as const;
export type SuitColourField = (typeof suitColourFields)[number];

const syntaxFields = ["kw", "fn", "str", "num", "type", "com", "punc"] as const;
const accentStates = ["accentHover", "accentFg", "accentText"] as const;

/** The schemes a Suit has, in a fixed order. */
export function suitSchemes(manifest: Pick<SuitManifest, "light" | "dark">): Scheme[] {
  return (["light", "dark"] as const).filter((scheme) => manifest[scheme] !== undefined);
}

function material(base: Material, own: SuitPalette): Material {
  return own.glass === undefined ? base : { ...base, glass: own.glass };
}

/**
 * The palette of `scheme` for a Suit. An accent without its hover, label and link colours takes
 * them as the accent picker fits them (`deriveAccent`); any the Suit gives are kept as given.
 */
export function suitPalette(manifest: SuitManifest, scheme: Scheme): Palette {
  const theme = themeSources[suitBaseThemes[manifest.base]];
  const own: SuitPalette = manifest[scheme] ?? {};
  const source = { ...theme[scheme], syntax: { ...theme[scheme].syntax } };
  for (const field of suitColourFields) {
    const value = own[field];
    if (value !== undefined) source[field] = value;
  }
  for (const field of syntaxFields) {
    const value = own.syntax?.[field];
    if (value !== undefined) source.syntax[field] = value;
  }
  const layers = material(theme.material[scheme], own);
  const accent = own.accent;
  if (accent === undefined || accentStates.every((field) => own[field] !== undefined))
    return schemePalette(source, scheme, layers);
  const fitted = deriveAccent(accent, scheme, schemePalette(source, scheme, layers));
  return schemePalette(
    {
      ...source,
      accent: fitted.accent,
      accentHover: own.accentHover ?? fitted.accentHover,
      accentFg: own.accentFg ?? fitted.accentFg,
      accentText: own.accentText ?? fitted.accentText,
    },
    scheme,
    layers,
  );
}
