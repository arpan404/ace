import { parseOpaqueColor } from "./colour.ts";
import { themes, withAccent, type Palette, type Scheme, type ThemeId } from "./palettes.ts";

/*
 * The accent picker's choices. An accent is laid over any theme: "theme" keeps the theme's own,
 * the curated colours and a custom one are fitted to the theme's surfaces (`accent-fit.ts`),
 * and Mono uses the theme's text colour.
 */

export const accentIds = [
  "theme",
  "blue",
  "violet",
  "teal",
  "green",
  "amber",
  "rose",
  "mono",
  "custom",
] as const;
export type AccentId = (typeof accentIds)[number];

/** The curated colours, before fitting. Each sits clear of the status colours it neighbours. */
export const curatedAccents: Record<
  Exclude<AccentId, "theme" | "mono" | "custom">,
  { name: string; colour: string }
> = {
  blue: { name: "Blue", colour: "#3D9BFF" },
  violet: { name: "Violet", colour: "#8E4FE0" },
  teal: { name: "Teal", colour: "#0F9488" },
  green: { name: "Green", colour: "#5E9E1F" },
  amber: { name: "Amber", colour: "#E0A21A" },
  rose: { name: "Rose", colour: "#E0446A" },
};

export const accentNames: Record<AccentId, string> = {
  theme: "Theme",
  ...Object.fromEntries(Object.entries(curatedAccents).map(([id, { name }]) => [id, name])),
  mono: "Mono",
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
    case "mono":
      return theme[scheme].t1;
    case "custom":
      return parseOpaqueColor(choice.customAccent) ? choice.customAccent : theme.accent[scheme];
    default:
      return curatedAccents[choice.accent].colour;
  }
}

/** One scheme of a theme with `choice` as its accent. */
export function themedPalette(id: ThemeId, scheme: Scheme, choice: AccentChoice): Palette {
  const palette = themes[id][scheme];
  if (choice.accent === "theme") return palette;
  return withAccent(palette, scheme, accentColour(id, scheme, choice));
}
