import { accentIds, themedPalette, type AccentId } from "./accent.ts";
import { contrastRatio, parseOpaqueColor, worstContrast } from "./colour.ts";
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
 * Phones have one accent for fills and links alike, so it is the web's link colour whenever the
 * fill's label still reads on it, and the fill colour otherwise.
 */
function phoneAccent(palette: Palette): string {
  const text = parseOpaqueColor(palette.accentText);
  const label = parseOpaqueColor(palette.accentFg);
  if (text && label && contrastRatio(label, text) >= 4.5) return palette.accentText;
  return palette.accent;
}

/** Every role of one theme, accent and scheme, from the web's fitted palette. */
export function phoneColours(theme: ThemeId, accent: PhoneAccentId, scheme: Scheme): PhoneColours {
  const palette = themedPalette(theme, scheme, { accent, customAccent: "#000000" });
  return {
    background: palette.s0,
    secondaryBackground: palette.s1,
    card: palette.s2,
    foreground: palette.t1,
    mutedForeground: palette.t2,
    subtleForeground: palette.t3,
    separator: palette.border,
    fill: palette.active,
    accent: phoneAccent(palette),
    onAccent: palette.accentFg,
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

export interface PhoneContrastWarning {
  theme: ThemeId;
  accent: PhoneAccentId;
  scheme: Scheme;
  label: string;
  ratio: number;
  minimum: number;
}

/**
 * Every WCAG AA failure of a phone's colours: words (the inks and the accent as a link) at 4.5:1
 * on every surface a phone draws text on, marks at 3:1 on the page, and labels on the accent
 * fill at 4.5:1. `base` holds the token colours the overrides sit on.
 */
export function phoneContrastWarnings(base: Record<Scheme, PhoneColours>): PhoneContrastWarning[] {
  const warnings: PhoneContrastWarning[] = [];
  for (const theme of themeIds)
    for (const accent of phoneAccentIds)
      for (const scheme of ["light", "dark"] as const) {
        const colours = { ...base[scheme], ...phoneOverrides(theme, accent, scheme) };
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
