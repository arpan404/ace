import { oklchToHex } from "./colour.ts";

/*
 * The themes (docs/design/visual-language.md, "Themes"). Every theme shares one neutral ramp:
 * twelve near-true greys per scheme, from canvas to text, so surfaces, borders and text read the
 * same whichever theme is on. Only Paper and Ember warm their greys, and only slightly; a theme's
 * identity is its accent. These are the only colours the app owns: every CSS token derives from
 * one palette in `tokens.ts`, and every palette passes WCAG AA on every surface (`contrast.ts`).
 */

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

/** Perceptual lightness (OKLCH L) of each step. Dark sidebars sit below the canvas, as in T3. */
const rampLightness: Record<Scheme, Record<RampStep, number>> = {
  light: {
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
  dark: {
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
};

/** A theme's greys: hue in degrees and chroma, near zero. */
interface Neutral {
  hue: number;
  chroma: number;
}
const trueGrey: Neutral = { hue: 0, chroma: 0 };

export type Ramp = Record<RampStep, string>;

function ramp(scheme: Scheme, neutral: Neutral): Ramp {
  const steps = rampLightness[scheme];
  return Object.fromEntries(
    rampSteps.map((step) => [step, oklchToHex(steps[step], neutral.chroma, neutral.hue)]),
  ) as Ramp;
}

/** What a theme chooses for itself in one scheme: its accent, and statuses it retunes. */
interface Accent {
  accent: string;
  accentHover: string;
  accentPressed: string;
  /** Labels on an accent fill. */
  accentFg: string;
  /** The accent as text: links, the current view. */
  accentText: string;
}
type StatusSet = {
  working: string;
  workingText: string;
  needs: string;
  needsText: string;
  failed: string;
  failedText: string;
  done: string;
  doneText: string;
};

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
}

export interface ThemeDefinition {
  name: string;
  light: Palette;
  dark: Palette;
}

/** Statuses every theme uses unless it retunes one to sit apart from its accent. */
const baseStatus: Record<Scheme, StatusSet> = {
  light: {
    working: "#2A62E3",
    workingText: "#2458CC",
    needs: "#C46A0B",
    needsText: "#9C520A",
    failed: "#D63B3B",
    failedText: "#B12B2B",
    done: "#2E8A50",
    doneText: "#23723F",
  },
  dark: {
    working: "#5C8DF0",
    workingText: "#86A9F5",
    needs: "#E9A14C",
    needsText: "#EFB46B",
    failed: "#EE7272",
    failedText: "#F29090",
    done: "#4DBE78",
    doneText: "#73CC94",
  },
};

function palette(
  scheme: Scheme,
  neutral: Neutral,
  accent: Accent,
  status: Partial<StatusSet> = {},
): Palette {
  const greys = ramp(scheme, neutral);
  const light = scheme === "light";
  return {
    ...greys,
    s0: greys.canvas,
    s1: greys.surface,
    s2: greys.raised,
    t1: greys.text,
    t2: greys.muted,
    t3: greys.subtle,
    code: oklchToHex(light ? 0.968 : 0.152, neutral.chroma, neutral.hue),
    shadow: light ? "20 20 22" : "0 0 0",
    ...accent,
    ...baseStatus[scheme],
    ...status,
  };
}

interface ThemeSpec {
  name: string;
  neutral: Neutral;
  light: Accent;
  dark: Accent;
  lightStatus?: Partial<StatusSet>;
  darkStatus?: Partial<StatusSet>;
}

function theme(spec: ThemeSpec): ThemeDefinition {
  return {
    name: spec.name,
    light: palette("light", spec.neutral, spec.light, spec.lightStatus),
    dark: palette("dark", spec.neutral, spec.dark, spec.darkStatus),
  };
}

export const themeIds = [
  "graphite",
  "ace",
  "mono",
  "paper",
  "dusk",
  "tide",
  "ember",
  "moss",
] as const;
export type ThemeId = (typeof themeIds)[number];
export const defaultThemeId: ThemeId = "graphite";

export const themes: Record<ThemeId, ThemeDefinition> = {
  // Pure grey with a restrained blue: the quiet default.
  graphite: theme({
    name: "Graphite",
    neutral: trueGrey,
    light: {
      accent: "#3A63C4",
      accentHover: "#3257B0",
      accentPressed: "#2A4A97",
      accentFg: "#FFFFFF",
      accentText: "#355CBA",
    },
    dark: {
      accent: "#7C9CE0",
      accentHover: "#8FABE6",
      accentPressed: "#6D8ED6",
      accentFg: "#0E1628",
      accentText: "#93AEEA",
    },
  }),
  // Pure grey with ace's bright blue.
  ace: theme({
    name: "Ace",
    neutral: trueGrey,
    light: {
      accent: "#2A62E3",
      accentHover: "#2256CC",
      accentPressed: "#1C49AF",
      accentFg: "#FFFFFF",
      accentText: "#2458CC",
    },
    dark: {
      accent: "#5C8DF0",
      accentHover: "#729DF3",
      accentPressed: "#4D7EE3",
      accentFg: "#0B1530",
      accentText: "#86A9F5",
    },
  }),
  // Black and white: the accent is the text colour.
  mono: theme({
    name: "Mono",
    neutral: trueGrey,
    light: {
      accent: "#1A1A1A",
      accentHover: "#333333",
      accentPressed: "#000000",
      accentFg: "#FFFFFF",
      accentText: "#1A1A1A",
    },
    dark: {
      accent: "#EDEDED",
      accentHover: "#FFFFFF",
      accentPressed: "#D4D4D4",
      accentFg: "#111111",
      accentText: "#EDEDED",
    },
  }),
  paper: theme({
    name: "Paper",
    neutral: { hue: 80, chroma: 0.006 },
    light: {
      accent: "#1E6A4E",
      accentHover: "#195C43",
      accentPressed: "#134A36",
      accentFg: "#FFFFFF",
      accentText: "#1E6A4E",
    },
    dark: {
      accent: "#6FBF98",
      accentHover: "#83CBA8",
      accentPressed: "#5EAD87",
      accentFg: "#0B2318",
      accentText: "#86CBA9",
    },
    // Green is the accent here, so done steps back to slate.
    lightStatus: {
      working: "#1E6A4E",
      workingText: "#1E6A4E",
      done: "#5A6A7B",
      doneText: "#4E5D6D",
    },
    darkStatus: {
      working: "#6FBF98",
      workingText: "#86CBA9",
      done: "#95A7BB",
      doneText: "#A9B8C8",
    },
  }),
  dusk: theme({
    name: "Dusk",
    neutral: trueGrey,
    light: {
      accent: "#5753C4",
      accentHover: "#4C48B3",
      accentPressed: "#403C9C",
      accentFg: "#FFFFFF",
      accentText: "#504CBA",
    },
    dark: {
      accent: "#9693F0",
      accentHover: "#A8A5F4",
      accentPressed: "#8582E2",
      accentFg: "#15132D",
      accentText: "#ABA8F5",
    },
    lightStatus: { working: "#5753C4", workingText: "#504CBA" },
    darkStatus: { working: "#9693F0", workingText: "#ABA8F5" },
  }),
  tide: theme({
    name: "Tide",
    neutral: trueGrey,
    light: {
      accent: "#0D6B75",
      accentHover: "#0A5D66",
      accentPressed: "#084E56",
      accentFg: "#FFFFFF",
      accentText: "#0D6B75",
    },
    dark: {
      accent: "#3FB6C0",
      accentHover: "#57C3CC",
      accentPressed: "#33A4AE",
      accentFg: "#052629",
      accentText: "#5DC5CE",
    },
    lightStatus: { working: "#0D6B75", workingText: "#0D6B75" },
    darkStatus: { working: "#3FB6C0", workingText: "#5DC5CE" },
  }),
  ember: theme({
    name: "Ember",
    neutral: { hue: 60, chroma: 0.006 },
    light: {
      accent: "#B1522A",
      accentHover: "#9D4723",
      accentPressed: "#853C1D",
      accentFg: "#FFFFFF",
      accentText: "#A04A25",
    },
    dark: {
      accent: "#E08A5C",
      accentHover: "#E79C72",
      accentPressed: "#D27B4D",
      accentFg: "#2A1206",
      accentText: "#E99A6F",
    },
    // Orange is the accent here, so working is a quiet blue and needs-you a deeper amber.
    lightStatus: {
      working: "#3C6C96",
      workingText: "#355F85",
      needs: "#A86B00",
      needsText: "#885700",
    },
    darkStatus: {
      working: "#7FA9D2",
      workingText: "#95B9DC",
      needs: "#E8B24A",
      needsText: "#EDC066",
    },
  }),
  moss: theme({
    name: "Moss",
    neutral: trueGrey,
    light: {
      accent: "#486A38",
      accentHover: "#3E5C30",
      accentPressed: "#334D28",
      accentFg: "#FFFFFF",
      accentText: "#456635",
    },
    dark: {
      accent: "#9DBE84",
      accentHover: "#AECB98",
      accentPressed: "#8EB075",
      accentFg: "#17210F",
      accentText: "#AFCB99",
    },
    lightStatus: {
      working: "#486A38",
      workingText: "#456635",
      done: "#56667A",
      doneText: "#4A596C",
    },
    darkStatus: {
      working: "#9DBE84",
      workingText: "#AFCB99",
      done: "#8FA6C0",
      doneText: "#A4B7CD",
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

/** Waiting and not-responding hues: shared by every theme of a scheme. */
export const sharedStatus: Record<Scheme, { waiting: string; unresponsive: string }> = {
  light: { waiting: "#7A5BD6", unresponsive: "#C2508A" },
  dark: { waiting: "#B49CF5", unresponsive: "#E88BB3" },
};
