import { oklchToHex } from "./colour.ts";
import type { ThemeTokens, TokenName } from "./tokens.ts";

export type Scheme = "light" | "dark";

export interface Theme {
  id: string;
  name: string;
  scheme: Scheme;
  tokens: ThemeTokens;
  /** Presets are read-only; the editor forks a custom copy on first edit. */
  preset: boolean;
}

/** The small seed a preset is generated from (DESIGN-fable.md, "Presets"). */
interface ThemeSeed {
  id: string;
  name: string;
  scheme: Scheme;
  background: string;
  foreground: string;
  mutedForeground: string;
  subtleForeground: string;
  popover: string;
  primaryForeground: string;
  destructive: string;
  /** The preset's own accent: focus, selection, primary actions and links. */
  accent: string;
  /** "r g b" triples; alpha comes from glass intensity. */
  reading: string;
  sidebar: string;
  rail: string;
  glass: string;
  code: string;
  wall: string;
  washes: readonly [string, string, string, string];
  overrides?: Partial<ThemeTokens>;
}

const seeds: readonly ThemeSeed[] = [
  {
    id: "light",
    name: "Light",
    scheme: "light",
    background: "#F4F4F7",
    foreground: "#1C1C22",
    mutedForeground: "#4B4B54",
    subtleForeground: "#5E5E66",
    popover: "#FFFFFF",
    primaryForeground: "#FFFFFF",
    destructive: "#D23F3F",
    accent: "#3269D4",
    reading: "255 255 255",
    sidebar: "243 243 247",
    rail: "238 238 243",
    glass: "255 255 255",
    code: "rgb(28 28 34 / 0.04)",
    wall: "#EBEBEF",
    washes: [
      "rgb(255 255 255 / 0.9)",
      "rgb(196 210 240 / 0.6)",
      "rgb(222 222 228 / 0.9)",
      "rgb(255 255 255 / 0.6)",
    ],
  },
  {
    id: "dark",
    name: "Dark",
    scheme: "dark",
    background: "#0F0F0F",
    foreground: "#ECECEC",
    mutedForeground: "#B3B3B3",
    subtleForeground: "#9C9C9C",
    popover: "#1B1B1B",
    primaryForeground: "#0F0F0F",
    destructive: "#F07171",
    accent: "#7AA2F7",
    reading: "17 17 17",
    sidebar: "24 24 24",
    rail: "16 16 16",
    glass: "30 30 30",
    code: "rgb(0 0 0 / 0.3)",
    wall: "#0A0A0A",
    washes: [
      "rgb(255 255 255 / 0.05)",
      "rgb(122 162 247 / 0.07)",
      "rgb(90 90 90 / 0.12)",
      "rgb(255 255 255 / 0.03)",
    ],
  },
  {
    id: "midnight",
    name: "Midnight",
    scheme: "dark",
    background: "#0B0D14",
    foreground: "#E6E8F0",
    mutedForeground: "#B0B3C1",
    subtleForeground: "#989CAB",
    popover: "#161925",
    primaryForeground: "#0B0D14",
    destructive: "#F07A86",
    accent: "#8C9EFF",
    reading: "14 16 23",
    sidebar: "20 23 33",
    rail: "12 14 21",
    glass: "27 31 43",
    code: "rgb(0 0 0 / 0.3)",
    wall: "#060810",
    washes: [
      "rgb(80 100 170 / 0.18)",
      "rgb(40 60 130 / 0.16)",
      "rgb(60 70 120 / 0.14)",
      "rgb(255 255 255 / 0.02)",
    ],
  },
  {
    id: "graphite",
    name: "Graphite",
    scheme: "dark",
    background: "#1A1917",
    foreground: "#ECE9E4",
    mutedForeground: "#C0BCB6",
    subtleForeground: "#ABA7A1",
    popover: "#262421",
    primaryForeground: "#1A1917",
    destructive: "#F08070",
    accent: "#5EBFC6",
    reading: "28 27 25",
    sidebar: "36 34 31",
    rail: "24 23 21",
    glass: "40 38 35",
    code: "rgb(0 0 0 / 0.25)",
    wall: "#141311",
    washes: [
      "rgb(255 240 220 / 0.05)",
      "rgb(160 140 120 / 0.12)",
      "rgb(110 100 90 / 0.12)",
      "rgb(255 255 255 / 0.02)",
    ],
  },
  {
    id: "paper",
    name: "Paper",
    scheme: "light",
    background: "#F6F3EC",
    foreground: "#26231E",
    mutedForeground: "#504B44",
    subtleForeground: "#605A53",
    popover: "#FFFDF8",
    primaryForeground: "#FFFDF8",
    destructive: "#C8423A",
    accent: "#17766E",
    reading: "253 251 246",
    sidebar: "243 239 230",
    rail: "236 232 222",
    glass: "255 253 248",
    code: "rgb(60 50 30 / 0.05)",
    wall: "#EDE9DF",
    washes: [
      "rgb(255 253 246 / 0.9)",
      "rgb(214 206 190 / 0.7)",
      "rgb(228 222 208 / 0.9)",
      "rgb(255 255 255 / 0.6)",
    ],
  },
  {
    id: "slate",
    name: "Slate",
    scheme: "dark",
    background: "#22272E",
    foreground: "#DDE3EA",
    mutedForeground: "#C1C8D0",
    subtleForeground: "#A7B0B9",
    popover: "#272C34",
    primaryForeground: "#22272E",
    destructive: "#E8818A",
    accent: "#88B4E8",
    reading: "36 41 48",
    sidebar: "40 46 54",
    rail: "30 35 42",
    glass: "40 46 54",
    code: "rgb(0 0 0 / 0.2)",
    wall: "#1B2027",
    washes: [
      "rgb(120 150 180 / 0.12)",
      "rgb(80 110 140 / 0.12)",
      "rgb(60 80 100 / 0.12)",
      "rgb(255 255 255 / 0.02)",
    ],
    overrides: {
      "--status-working": "#88B4E8",
      "--status-waiting": "#B8A6EE",
      "--status-done": "#8FCBA3",
      "--status-needs-you": "#EBB06C",
      "--accent-blue": "#88B4E8",
    },
  },
  {
    id: "contrast",
    name: "High contrast",
    scheme: "dark",
    background: "#000000",
    foreground: "#FFFFFF",
    mutedForeground: "#D4D4D4",
    subtleForeground: "#A6A6A6",
    popover: "#000000",
    primaryForeground: "#000000",
    destructive: "#FF6B6B",
    accent: "#7CC0FF",
    reading: "0 0 0",
    sidebar: "10 10 10",
    rail: "0 0 0",
    glass: "10 10 10",
    code: "rgb(255 255 255 / 0.08)",
    wall: "#000000",
    washes: ["transparent", "transparent", "transparent", "transparent"],
    overrides: {
      "--border": "rgb(255 255 255 / 0.35)",
      "--input": "rgb(255 255 255 / 0.55)",
      "--secondary": "rgb(255 255 255 / 0.16)",
      "--muted": "rgb(255 255 255 / 0.1)",
      "--accent": "rgb(255 255 255 / 0.14)",
      "--sidebar-accent": "rgb(255 255 255 / 0.14)",
      "--sidebar-border": "rgb(255 255 255 / 0.35)",
      "--glass-a": "1",
      "--glass-border": "rgb(255 255 255 / 0.5)",
      "--glass-blur": "0px",
      "--bubble": "rgb(255 255 255 / 0.14)",
      "--status-needs-you": "#FFB454",
      "--status-working": "#7CC0FF",
      "--status-waiting": "#C8B3FF",
      "--status-failed": "#FF7A7A",
      "--status-done": "#7EE2A0",
      "--accent-blue": "#7CC0FF",
      "--diff-add": "rgb(126 226 160 / 0.22)",
      "--diff-del": "rgb(255 122 122 / 0.22)",
    },
  },
];

type StatusTokens = Pick<
  ThemeTokens,
  | "--status-needs-you"
  | "--status-working"
  | "--status-waiting"
  | "--status-unresponsive"
  | "--status-failed"
  | "--status-done"
>;

const statusSets: Record<Scheme, StatusTokens> = {
  dark: {
    "--status-needs-you": "#F0A35E",
    "--status-working": "#7AA2F7",
    "--status-waiting": "#B49CF5",
    "--status-unresponsive": "#E88BB3",
    "--status-failed": "#F07171",
    "--status-done": "#6CC48F",
  },
  light: {
    "--status-needs-you": "#C9711A",
    "--status-working": "#3B74E0",
    "--status-waiting": "#7A5BD6",
    "--status-unresponsive": "#C2508A",
    "--status-failed": "#D23F3F",
    "--status-done": "#2E9A5E",
  },
};

export const accentNames = ["blue", "violet", "teal", "amber", "rose", "graphite"] as const;
export type AccentName = (typeof accentNames)[number];

const accentSets: Record<Scheme, Record<AccentName, string>> = {
  dark: {
    blue: "#7AA2F7",
    violet: "#B49CF5",
    teal: "#5FC7B3",
    amber: "#F0B35E",
    rose: "#F08BA7",
    graphite: "#B7B7C2",
  },
  light: {
    blue: "#3269D4",
    violet: "#7A5BD6",
    teal: "#167A6A",
    amber: "#A65B10",
    rose: "#C23C68",
    graphite: "#5A5A66",
  },
};

/**
 * Project badge tints: twelve hues around the wheel at one perceptual lightness per scheme, so
 * no project looks louder than another. Each reads as text on the theme's background (AA); a
 * badge draws its letters in the tint on a wash of it.
 */
const projectHues = [25, 55, 85, 125, 150, 178, 205, 240, 268, 295, 325, 355] as const;
const projectLightness: Record<Scheme, { l: number; c: number }> = {
  dark: { l: 0.85, c: 0.12 },
  light: { l: 0.41, c: 0.14 },
};
type ProjectToken = Extract<TokenName, `--project-${number}`>;
function projectTints(scheme: Scheme): Record<ProjectToken, string> {
  const { l, c } = projectLightness[scheme];
  return Object.fromEntries(
    projectHues.map((hue, index) => [`--project-${index + 1}`, oklchToHex(l, c, hue)]),
  ) as Record<ProjectToken, string>;
}
const projectSets: Record<Scheme, Record<ProjectToken, string>> = {
  dark: projectTints("dark"),
  light: projectTints("light"),
};
/** How many project tints a theme has; `--project-1` to `--project-${projectTintCount}`. */
export const projectTintCount = projectHues.length;

/** "#RRGGBB" or "#RGB" to "r g b". */
export function hexToRgbTriple(hex: string): string {
  let digits = hex.replace("#", "");
  if (digits.length === 3) digits = [...digits].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)).join(" ");
}

/** Expand a seed into the full token set. Alpha tokens derive from the foreground. */
function expand(seed: ThemeSeed): Theme {
  const dark = seed.scheme === "dark";
  const fg = hexToRgbTriple(seed.foreground);
  const ink = (alpha: number) => `rgb(${fg} / ${alpha})`;
  const accents = accentSets[seed.scheme];
  const tokens: ThemeTokens = {
    "--background": seed.background,
    "--reading-rgb": seed.reading,
    "--sidebar-rgb": seed.sidebar,
    "--rail-rgb": seed.rail,
    "--popover": seed.popover,
    "--card": dark ? ink(0.045) : "rgb(255 255 255 / 0.7)",
    "--secondary": ink(dark ? 0.07 : 0.06),
    "--muted": ink(dark ? 0.05 : 0.045),
    "--accent": ink(dark ? 0.06 : 0.05),
    "--border": ink(dark ? 0.09 : 0.09),
    "--input": ink(dark ? 0.12 : 0.14),
    "--code": seed.code,
    "--bubble": ink(dark ? 0.07 : 0.06),
    "--foreground": seed.foreground,
    "--muted-foreground": seed.mutedForeground,
    "--subtle-foreground": seed.subtleForeground,
    "--primary": seed.foreground,
    "--primary-foreground": seed.primaryForeground,
    "--destructive": seed.destructive,
    "--sidebar-foreground": `color-mix(in oklab, ${seed.foreground} 90%, ${seed.background})`,
    "--sidebar-accent": ink(dark ? 0.06 : 0.055),
    "--sidebar-border": ink(dark ? 0.07 : 0.08),
    ...statusSets[seed.scheme],
    "--accent-theme": seed.accent,
    "--accent-blue": accents.blue,
    "--accent-violet": accents.violet,
    "--accent-teal": accents.teal,
    "--accent-amber": accents.amber,
    "--accent-rose": accents.rose,
    "--accent-graphite": accents.graphite,
    "--glass-rgb": seed.glass,
    "--glass-a": dark ? "0.58" : "0.66",
    "--glass-blur": "24px",
    "--glass-border": dark ? "rgb(255 255 255 / 0.1)" : "rgb(255 255 255 / 0.85)",
    "--glass-edge": dark ? "rgb(0 0 0 / 0.35)" : "rgb(28 28 34 / 0.08)",
    "--glass-highlight": dark
      ? "inset 0 1px 0 rgb(255 255 255 / 0.06)"
      : "inset 0 1px 0 rgb(255 255 255 / 0.95)",
    "--glass-shadow": dark
      ? "0 12px 40px rgb(0 0 0 / 0.42), 0 1px 4px rgb(0 0 0 / 0.25)"
      : "0 12px 40px rgb(20 20 30 / 0.12), 0 1px 4px rgb(20 20 30 / 0.05)",
    "--diff-add": dark ? "rgb(108 196 143 / 0.16)" : "rgb(46 154 94 / 0.14)",
    "--diff-del": dark ? "rgb(240 113 113 / 0.15)" : "rgb(210 63 63 / 0.12)",
    ...projectSets[seed.scheme],
    "--wall": seed.wall,
    "--w1": seed.washes[0],
    "--w2": seed.washes[1],
    "--w3": seed.washes[2],
    "--w4": seed.washes[3],
    "--radius-sm": "8px",
    "--radius": "10px",
    "--radius-lg": "16px",
    "--radius-xl": "22px",
  };
  return {
    id: seed.id,
    name: seed.name,
    scheme: seed.scheme,
    tokens: { ...tokens, ...stripUndefined(seed.overrides) },
    preset: true,
  };
}

function stripUndefined(values: Partial<ThemeTokens> | undefined): Partial<ThemeTokens> {
  const out: Partial<ThemeTokens> = {};
  for (const [name, value] of Object.entries(values ?? {}) as [TokenName, string | undefined][])
    if (value !== undefined) out[name] = value;
  return out;
}

export const presetThemes: readonly Theme[] = seeds.map(expand);
/** New installs follow the operating system's light or dark preference. */
export const defaultThemeId = "system";

export function presetTheme(id: string): Theme | undefined {
  return presetThemes.find((theme) => theme.id === id);
}
/** The preset a custom theme falls back to for any token it does not set. */
export function basePreset(scheme: Scheme): Theme {
  const theme = presetTheme(scheme === "dark" ? "dark" : "light");
  if (!theme) throw new Error("Base presets are always defined");
  return theme;
}
