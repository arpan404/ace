import { parseOpaqueColor } from "./colour.ts";
import { themes, withAccent, type Palette, type Scheme, type ThemeId } from "./palettes.ts";

/*
 * The accent picker's choices. An accent is laid over any theme: "theme" keeps the theme's own,
 * the curated colours and a custom one are fitted to the theme's surfaces (`accent-fit.ts`),
 * and Ink uses the theme's text colour (ace's own accent is its ink).
 */

export const accentIds = [
  "theme",
  "blue",
  "teal",
  "green",
  "orange",
  "magenta",
  "ink",
  "custom",
] as const;
export type AccentId = (typeof accentIds)[number];

/**
 * The curated colours: one hue drawn twice, deep for light schemes and bright for dark ones, so
 * the same choice reads as the same colour in both. Each pair already passes the fitting
 * (`accent-fit.ts`) on every theme and sits clear of the status hues (working blue, needs amber,
 * done green-teal, failed red, waiting violet, not-responding pink), so fitting never turns it.
 */
export const curatedAccents: Record<
  Exclude<AccentId, "theme" | "ink" | "custom">,
  { name: string; colour: Record<Scheme, string> }
> = {
  blue: { name: "Blue", colour: { light: "#0A7CA6", dark: "#4FB6F5" } },
  teal: { name: "Teal", colour: { light: "#00676A", dark: "#56E0DD" } },
  green: { name: "Green", colour: { light: "#2F6E12", dark: "#84CF5E" } },
  orange: { name: "Orange", colour: { light: "#C2410C", dark: "#F5925A" } },
  magenta: { name: "Magenta", colour: { light: "#A0289F", dark: "#FCA1FE" } },
};

export const accentNames: Record<AccentId, string> = {
  theme: "Theme",
  ...Object.fromEntries(Object.entries(curatedAccents).map(([id, { name }]) => [id, name])),
  ink: "Ink",
  custom: "Custom",
} as Record<AccentId, string>;

export const defaultCustomAccent = "#3E8E7E";

export interface AccentChoice {
  accent: AccentId;
  /** "#RRGGBB"; used while `accent` is "custom". */
  customAccent: string;
}
export const themeAccent: AccentChoice = { accent: "theme", customAccent: defaultCustomAccent };

/** The colour `choice` asks for in one scheme of a theme, before it is fitted. */
export function accentColour(id: ThemeId, scheme: Scheme, choice: AccentChoice): string {
  const theme = themes[id];
  switch (choice.accent) {
    case "theme":
      return theme.accent[scheme];
    case "ink":
      return theme[scheme].t1;
    case "custom":
      return parseOpaqueColor(choice.customAccent) ? choice.customAccent : theme.accent[scheme];
    default:
      return curatedAccents[choice.accent].colour[scheme];
  }
}

/** One scheme of a theme with `choice` as its accent. */
export function themedPalette(id: ThemeId, scheme: Scheme, choice: AccentChoice): Palette {
  const palette = themes[id][scheme];
  if (choice.accent === "theme") return palette;
  return withAccent(palette, scheme, accentColour(id, scheme, choice));
}
