import { accentIds, themedPalette, type AccentChoice, type AccentId } from "./accent.ts";
import { contrastRatio, parseOpaqueColor, readableOn, worstContrast } from "./colour.ts";
import { themeIds, type ThemeId } from "./palettes.ts";
import type { Palette, Scheme } from "./types.ts";

/*
 * The themes on a phone. Native apps draw from a small set of colour roles (the design tokens'
 * scheme colours); a theme and an accent fill those roles from the web's own fitted palettes, so
 * a phone in Paper with Teal draws exactly the web's Paper with Teal. Pure.
 */

/** The token colour roles a theme recolours. Status colours are the same in every theme. */
export const phoneColourRoles = [
  "background",
  "secondaryBackground",
  "card",
  "foreground",
  "mutedForeground",
  "subtleForeground",
  "separator",
  "fill",
  "accent",
  "onAccent",
  "decoration",
] as const;
export type PhoneColourRole = (typeof phoneColourRoles)[number];
export type PhoneColours = Record<PhoneColourRole, string>;

/** Phones offer every accent but Custom, which needs a colour field and live fitting. */
export const phoneAccentIds = accentIds.filter(
  (id): id is Exclude<AccentId, "custom"> => id !== "custom",
);
export type PhoneAccentId = (typeof phoneAccentIds)[number];

/** The roles ace's own theme leaves to the design tokens: everything but the accent. */
const accentRoles: readonly PhoneColourRole[] = ["accent", "onAccent"];

/**
 * Phones have one accent for fills and links alike, so it is the web's link colour, which reads
 * at AA on every surface. Its label is the web's fill label where that reads on it, and black
 * or white, whichever reads better, where it doesn't (a very light pick fitted to a light fill).
 */
function phoneAccent(palette: Palette): PhoneAccentPair {
  const text = parseOpaqueColor(palette.accentText);
  const label = parseOpaqueColor(palette.accentFg);
  if (!text) return { accent: palette.accent, onAccent: palette.accentFg };
  const reads = label !== undefined && contrastRatio(label, text) >= 4.5;
  return {
    accent: palette.accentText,
    onAccent: reads ? palette.accentFg : readableOn(palette.accentText),
  };
}

/** Every role of one theme, accent and scheme, from the web's fitted palette. */
export function phoneColours(theme: ThemeId, accent: PhoneAccentId, scheme: Scheme): PhoneColours {
  return coloursOf(themedPalette(theme, scheme, { accent, customAccent: "#000000" }));
}

function coloursOf(palette: Palette): PhoneColours {
  return {
    background: palette.s0,
    secondaryBackground: palette.s1,
    card: palette.s2,
    foreground: palette.t1,
    mutedForeground: palette.t2,
    subtleForeground: palette.t3,
    separator: palette.border,
    fill: palette.active,
    ...phoneAccent(palette),
    decoration: palette.faint,
  };
}

/**
 * What a phone overrides for one theme and accent: ace's neutral roles are the design tokens
 * already, so ace changes only its accent, and ace with its own accent changes nothing.
 */
export function phoneOverrides(
  theme: ThemeId,
  accent: PhoneAccentId,
  scheme: Scheme,
): Partial<PhoneColours> {
  const colours = phoneColours(theme, accent, scheme);
  if (theme !== "ace") return colours;
  if (accent === "theme") return {};
  return Object.fromEntries(accentRoles.map((role) => [role, colours[role]]));
}

/** A picked colour's accent and label in one theme and scheme. */
export type PhoneAccentPair = Pick<PhoneColours, "accent" | "onAccent">;
/** A custom accent fitted to every theme in both schemes. */
export type PhoneCustomAccent = Record<ThemeId, Record<Scheme, PhoneAccentPair>>;

/**
 * A custom accent ("#RRGGBB") fitted to each theme in each scheme with the web's own fitting
 * (`deriveAccent`), so its fills, labels and links read at AA everywhere. Undefined when the
 * colour isn't one opaque hex colour.
 */
export function phoneCustomAccent(colour: string): PhoneCustomAccent | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return undefined;
  const choice: AccentChoice = { accent: "custom", customAccent: colour.toUpperCase() };
  const fit = (theme: ThemeId, scheme: Scheme): PhoneAccentPair => {
    const colours = coloursOf(themedPalette(theme, scheme, choice));
    return { accent: colours.accent, onAccent: colours.onAccent };
  };
  return Object.fromEntries(
    themeIds.map((theme) => [theme, { light: fit(theme, "light"), dark: fit(theme, "dark") }]),
  ) as PhoneCustomAccent;
}

export interface PhoneContrastWarning {
  theme: ThemeId;
  /** A preset accent id, or the custom colour checked. */
  accent: string;
  scheme: Scheme;
  label: string;
  ratio: number;
  minimum: number;
}

/**
 * Every WCAG AA failure of a phone's colours: words (the inks and the accent as a link) at 4.5:1
 * on every surface a phone draws text on, marks at 3:1 on the page, and labels on the accent
 * fill at 4.5:1. `base` holds the token colours the overrides sit on; `customColours` are
 * picked colours checked as custom accents over every theme.
 */
export function phoneContrastWarnings(
  base: Record<Scheme, PhoneColours>,
  customColours: readonly string[] = [],
): PhoneContrastWarning[] {
  const warnings: PhoneContrastWarning[] = [];
  const presets: readonly string[] = phoneAccentIds;
  for (const theme of themeIds)
    for (const accent of [...phoneAccentIds, ...customColours])
      for (const scheme of ["light", "dark"] as const) {
        const custom = presets.includes(accent) ? undefined : phoneCustomAccent(accent);
        const overrides = custom
          ? { ...phoneOverrides(theme, "theme", scheme), ...custom[theme][scheme] }
          : phoneOverrides(theme, accent as PhoneAccentId, scheme);
        const colours = { ...base[scheme], ...overrides };
        const rgb = (role: PhoneColourRole) => parseOpaqueColor(colours[role]) ?? [0, 0, 0];
        const surfaces = (["background", "secondaryBackground", "card", "fill"] as const).map(rgb);
        const check = (label: string, ratio: number, minimum: number) => {
          if (ratio < minimum) warnings.push({ theme, accent, scheme, label, ratio, minimum });
        };
        for (const role of ["foreground", "mutedForeground", "subtleForeground", "accent"] as const)
          check(role, worstContrast(rgb(role), surfaces), 4.5);
        check("decoration", contrastRatio(rgb("decoration"), rgb("background")), 3);
        check("onAccent", contrastRatio(rgb("onAccent"), rgb("accent")), 4.5);
      }
  return warnings;
}
