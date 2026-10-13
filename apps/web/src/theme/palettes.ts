import { deriveAccent } from "./accent-fit.ts";
import { oklchToHex, readableAcross } from "./colour.ts";
import { paletteSurfaces } from "./surfaces.ts";
import { status } from "./status.ts";
import {
  rampSteps,
  type Base,
  type Material,
  type Palette,
  type Ramp,
  type RampStep,
  type Scheme,
  type ThemeDefinition,
} from "./types.ts";

export { rampSteps } from "./types.ts";
export { sharedStatus, status } from "./status.ts";
export type {
  Accent,
  Base,
  Material,
  Palette,
  PaletteColour,
  Ramp,
  RampStep,
  Scheme,
  StatusSet,
  ThemeDefinition,
} from "./types.ts";

/*
 * The themes (docs/design/visual-language.md, "Themes"). A theme is a material, not an accent:
 * each one owns its neutral ramp (twelve steps from canvas to text, with its own lightness
 * curve, temperature and chroma), its contrast, its glass and its default accent. The accent is
 * a separate choice (`accent.ts`) laid over any theme; status colours are the same everywhere.
 * These are the only colours the app owns: every CSS token derives from one palette in
 * `tokens.ts`, and every palette passes WCAG AA on every surface (`contrast.ts`).
 */

/** Steps drawn as ink. They carry less of the theme's tint than its surfaces do. */
const inkSteps: ReadonlySet<RampStep> = new Set(["faint", "subtle", "muted", "text"]);

/** One scheme of a theme's greys: perceptual lightness (OKLCH L) per step, hue and chroma. */
interface RampSpec {
  hue: number;
  chroma: number;
  /** Chroma of the ink steps; 0.6 of `chroma` when unset. */
  inkChroma?: number;
  lightness: Record<RampStep, number>;
}

function ramp(spec: RampSpec): Ramp {
  return Object.fromEntries(
    rampSteps.map((step) => [
      step,
      oklchToHex(
        spec.lightness[step],
        inkSteps.has(step) ? (spec.inkChroma ?? spec.chroma * 0.6) : spec.chroma,
        spec.hue,
      ),
    ]),
  ) as Ramp;
}

interface SchemeSpec extends RampSpec {
  /** Lightness of code blocks. */
  code: number;
}
interface ThemeSpec {
  name: string;
  character: string;
  accent: Record<Scheme, string>;
  material: Record<Scheme, Material>;
  light: SchemeSpec;
  dark: SchemeSpec;
}

function base(scheme: Scheme, spec: SchemeSpec, material: Material): Base {
  const greys = ramp(spec);
  const light = scheme === "light";
  const shadow = oklchToHex(light ? 0.24 : 0.08, spec.chroma * 1.5, spec.hue);
  const palette: Base = {
    ...greys,
    s0: greys.canvas,
    s1: greys.surface,
    s2: greys.raised,
    t1: greys.text,
    t2: greys.muted,
    t3: greys.subtle,
    code: oklchToHex(spec.code, spec.chroma, spec.hue),
    shadow: [1, 3, 5].map((at) => Number.parseInt(shadow.slice(at, at + 2), 16)).join(" "),
    material,
    ...status[scheme],
  };
  // Status marks are the same everywhere; their words step toward the text colour where a
  // theme's surfaces need it to read at AA.
  const surfaces = paletteSurfaces(palette, scheme).map((surface) => surface.rgb);
  const words = (colour: string) => readableAcross(colour, surfaces, !light) ?? greys.text;
  return {
    ...palette,
    workingText: words(palette.workingText),
    needsText: words(palette.needsText),
    failedText: words(palette.failedText),
    doneText: words(palette.doneText),
  };
}

/** A palette with `accentColour` fitted to it (AA labels, marks and links on its surfaces). */
export function withAccent(palette: Base, scheme: Scheme, accentColour: string): Palette {
  return { ...palette, ...deriveAccent(accentColour, scheme, palette) };
}

function theme(spec: ThemeSpec): ThemeDefinition {
  const scheme = (name: Scheme) =>
    withAccent(base(name, spec[name], spec.material[name]), name, spec.accent[name]);
  return {
    name: spec.name,
    character: spec.character,
    accent: spec.accent,
    light: scheme("light"),
    dark: scheme("dark"),
  };
}

const glassy: Record<Scheme, Material> = {
  light: { glass: { blur: 0.64, liquid: 0.56 }, focus: 60 },
  dark: { glass: { blur: 0.68, liquid: 0.62 }, focus: 60 },
};

export const themeIds = ["graphite", "midnight", "paper", "slate", "contrast", "aurora"] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultThemeId: ThemeId = "graphite";

export const themes: Record<ThemeId, ThemeDefinition> = {
  graphite: theme({
    name: "Graphite",
    character: "True greys at medium contrast, with a steel accent",
    accent: { light: "#4F6A8F", dark: "#9FB3D1" },
    material: glassy,
    light: {
      hue: 0,
      chroma: 0,
      code: 0.968,
      lightness: {
        canvas: 0.993,
        sidebar: 0.973,
        surface: 0.962,
        raised: 1,
        hover: 0.948,
        active: 0.928,
        border: 0.912,
        borderStrong: 0.858,
        faint: 0.64,
        subtle: 0.5,
        muted: 0.41,
        text: 0.215,
      },
    },
    dark: {
      hue: 0,
      chroma: 0,
      code: 0.152,
      lightness: {
        canvas: 0.2,
        sidebar: 0.178,
        surface: 0.232,
        raised: 0.25,
        hover: 0.268,
        active: 0.298,
        border: 0.31,
        borderStrong: 0.38,
        faint: 0.54,
        subtle: 0.7,
        muted: 0.81,
        text: 0.955,
      },
    },
  }),
  midnight: theme({
    name: "Midnight",
    character: "Deep blue-black, cool and crisp, with a cyan accent",
    accent: { light: "#0B7FA8", dark: "#4CC4E8" },
    material: glassy,
    light: {
      hue: 255,
      chroma: 0.02,
      inkChroma: 0.045,
      code: 0.95,
      lightness: {
        canvas: 0.978,
        sidebar: 0.952,
        surface: 0.944,
        raised: 1,
        hover: 0.93,
        active: 0.908,
        border: 0.893,
        borderStrong: 0.846,
        faint: 0.62,
        subtle: 0.495,
        muted: 0.405,
        text: 0.215,
      },
    },
    dark: {
      hue: 258,
      chroma: 0.03,
      code: 0.135,
      lightness: {
        canvas: 0.172,
        sidebar: 0.15,
        surface: 0.202,
        raised: 0.222,
        hover: 0.24,
        active: 0.27,
        border: 0.288,
        borderStrong: 0.36,
        faint: 0.55,
        subtle: 0.71,
        muted: 0.82,
        text: 0.948,
      },
    },
  }),
  paper: theme({
    name: "Paper",
    character: "Warm cream and umber at a soft contrast, with a terracotta accent",
    accent: { light: "#B0552E", dark: "#E39A6B" },
    material: glassy,
    light: {
      hue: 78,
      chroma: 0.017,
      code: 0.935,
      lightness: {
        canvas: 0.97,
        sidebar: 0.945,
        surface: 0.938,
        raised: 0.99,
        hover: 0.925,
        active: 0.905,
        border: 0.885,
        borderStrong: 0.83,
        faint: 0.6,
        subtle: 0.485,
        muted: 0.4,
        text: 0.28,
      },
    },
    dark: {
      hue: 70,
      chroma: 0.014,
      code: 0.185,
      lightness: {
        canvas: 0.225,
        sidebar: 0.2,
        surface: 0.255,
        raised: 0.272,
        hover: 0.29,
        active: 0.315,
        border: 0.332,
        borderStrong: 0.4,
        faint: 0.58,
        subtle: 0.72,
        muted: 0.81,
        text: 0.915,
      },
    },
  }),
  slate: theme({
    name: "Slate",
    character: "Mid-tone blue-grey with low glare in light and dark, with a teal accent",
    accent: { light: "#2A8C80", dark: "#5CC2B3" },
    material: glassy,
    light: {
      hue: 245,
      chroma: 0.009,
      code: 0.915,
      lightness: {
        canvas: 0.952,
        sidebar: 0.93,
        surface: 0.928,
        raised: 0.972,
        hover: 0.912,
        active: 0.892,
        border: 0.872,
        borderStrong: 0.81,
        faint: 0.585,
        subtle: 0.47,
        muted: 0.39,
        text: 0.24,
      },
    },
    dark: {
      hue: 245,
      chroma: 0.016,
      code: 0.25,
      lightness: {
        canvas: 0.29,
        sidebar: 0.265,
        surface: 0.315,
        raised: 0.33,
        hover: 0.35,
        active: 0.374,
        border: 0.392,
        borderStrong: 0.46,
        faint: 0.64,
        subtle: 0.77,
        muted: 0.85,
        text: 0.94,
      },
    },
  }),
  contrast: theme({
    name: "Contrast",
    character: "Black and white at the highest contrast, solid layers and full focus rings",
    accent: { light: "#1D3FB8", dark: "#FFD447" },
    material: {
      light: { glass: { blur: 1, liquid: 1 }, focus: 100 },
      dark: { glass: { blur: 1, liquid: 1 }, focus: 100 },
    },
    light: {
      hue: 0,
      chroma: 0,
      code: 0.965,
      lightness: {
        canvas: 1,
        sidebar: 1,
        surface: 0.968,
        raised: 1,
        hover: 0.935,
        active: 0.9,
        border: 0.56,
        borderStrong: 0.42,
        faint: 0.5,
        subtle: 0.36,
        muted: 0.28,
        text: 0,
      },
    },
    dark: {
      hue: 0,
      chroma: 0,
      code: 0.13,
      lightness: {
        canvas: 0,
        sidebar: 0,
        surface: 0.17,
        raised: 0.19,
        hover: 0.255,
        active: 0.3,
        border: 0.58,
        borderStrong: 0.72,
        faint: 0.72,
        subtle: 0.86,
        muted: 0.94,
        text: 1,
      },
    },
  }),
  aurora: theme({
    name: "Aurora",
    character: "Violet dusk with clear glass layers, with a magenta accent",
    accent: { light: "#B0359F", dark: "#E77BD6" },
    material: {
      light: { glass: { blur: 0.5, liquid: 0.42 }, focus: 60 },
      dark: { glass: { blur: 0.54, liquid: 0.46 }, focus: 60 },
    },
    light: {
      hue: 300,
      chroma: 0.02,
      inkChroma: 0.04,
      code: 0.942,
      lightness: {
        canvas: 0.972,
        sidebar: 0.944,
        surface: 0.938,
        raised: 0.995,
        hover: 0.93,
        active: 0.908,
        border: 0.893,
        borderStrong: 0.838,
        faint: 0.61,
        subtle: 0.485,
        muted: 0.4,
        text: 0.225,
      },
    },
    dark: {
      hue: 300,
      chroma: 0.042,
      inkChroma: 0.03,
      code: 0.135,
      lightness: {
        canvas: 0.2,
        sidebar: 0.178,
        surface: 0.232,
        raised: 0.25,
        hover: 0.268,
        active: 0.298,
        border: 0.315,
        borderStrong: 0.385,
        faint: 0.585,
        subtle: 0.73,
        muted: 0.83,
        text: 0.955,
      },
    },
  }),
};

/** Code syntax colours, shared by every theme of a scheme. */
export const syntax: Record<
  Scheme,
  { kw: string; str: string; num: string; fn: string; type: string; com: string }
> = {
  light: {
    kw: "#9A3AAE",
    str: "#2F7A3A",
    num: "#B0560A",
    fn: "#2557C4",
    type: "#0E7280",
    com: "#6E737C",
  },
  dark: {
    kw: "#D490E6",
    str: "#8FD19B",
    num: "#F0A868",
    fn: "#86ACF6",
    type: "#6CCFD8",
    com: "#8A8F98",
  },
};
