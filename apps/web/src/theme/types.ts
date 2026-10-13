/* The shape of a theme's palette, shared by the theme modules. */

export type Scheme = "light" | "dark";

/** The neutral ramp, in order. Each name is also a palette field and a CSS token. */
export const rampSteps = [
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
] as const;
export type RampStep = (typeof rampSteps)[number];
export type Ramp = Record<RampStep, string>;

/** The accent tokens: derived from one colour by `deriveAccent`. */
export interface Accent {
  accent: string;
  accentHover: string;
  accentPressed: string;
  /** Labels on an accent fill. */
  accentFg: string;
  /** The accent as text: links, the current view. */
  accentText: string;
}
export type StatusSet = {
  working: string;
  workingText: string;
  needs: string;
  needsText: string;
  failed: string;
  failedText: string;
  done: string;
  doneText: string;
};

/**
 * How a theme's floating layers are made. `glass` is the tint's opacity over the page (blur,
 * then the thinner liquid tint), 1 for no glass at all; `focus` is how much of the accent the
 * focus ring carries.
 */
export interface Material {
  glass: { blur: number; liquid: number };
  focus: number;
}

export interface Palette extends Ramp, Accent, StatusSet {
  /** The page; also `canvas`. */
  s0: string;
  /** Quiet raised fills: bubbles, cards, hunk headers; also `surface`. */
  s1: string;
  /** Floating layers when solid; also `raised`. */
  s2: string;
  /** Primary, secondary and quiet text; also `text`, `muted`, `subtle`. */
  t1: string;
  t2: string;
  t3: string;
  code: string;
  /** "r g b" of the shadow tint. */
  shadow: string;
  material: Material;
}
/** The palette fields that hold a colour. */
export type PaletteColour = Exclude<keyof Palette, "material">;

export interface ThemeDefinition {
  name: string;
  /** One line on the theme's character, for its swatch's accessible description. */
  character: string;
  /** The theme's own accent colour, before it is fitted to a scheme. */
  accent: Record<Scheme, string>;
  light: Palette;
  dark: Palette;
}

/** A palette before its accent: the ramp, statuses and material. */
export type Base = Omit<Palette, keyof Accent>;
