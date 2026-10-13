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

/** The accent tokens: a theme's own, or one colour fitted by `deriveAccent`. */
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

/** Diff rows: opaque fills over the code background, and the gutter text on them. */
export interface DiffSet {
  diffAdd: string;
  diffAddFg: string;
  diffDel: string;
  diffDelFg: string;
}

/** Code syntax colours. */
export interface Syntax {
  kw: string;
  fn: string;
  str: string;
  num: string;
  type: string;
  com: string;
  punc: string;
}

/**
 * How a theme's floating layers are made. `glass` is the tint's opacity over the page (blur,
 * then the thinner liquid tint), 1 for no glass at all; `focus` is how much of the accent the
 * focus ring carries.
 */
export interface Material {
  glass: { blur: number; liquid: number };
  focus: number;
}

/** Font stacks: the interface, transcript prose and code. System fonts only. */
export interface ThemeFonts {
  ui: string;
  prose: string;
  mono: string;
}

/** One scheme of a theme as designed: every colour given, none derived. */
export interface SchemeSource extends Ramp, StatusSet, DiffSet {
  code: string;
  accent: string;
  accentHover: string;
  accentFg: string;
  accentText: string;
  syntax: Syntax;
}

/** A theme as designed: `palettes.ts` turns it into a `ThemeDefinition`. */
export interface ThemeSource {
  name: string;
  /** One line on the theme's character, for its swatch's accessible description. */
  character: string;
  fonts: ThemeFonts;
  material: Record<Scheme, Material>;
  light: SchemeSource;
  dark: SchemeSource;
}

export interface Palette extends Ramp, Accent, StatusSet, DiffSet {
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
  syntax: Syntax;
  material: Material;
}
/** The palette fields that hold a colour. */
export type PaletteColour = Exclude<keyof Palette, "material" | "syntax">;

export interface ThemeDefinition {
  name: string;
  character: string;
  fonts: ThemeFonts;
  /** The theme's own accent colour in each scheme. */
  accent: Record<Scheme, string>;
  light: Palette;
  dark: Palette;
}

/** A palette before its accent: the ramp, statuses, code and material. */
export type Base = Omit<Palette, keyof Accent>;
