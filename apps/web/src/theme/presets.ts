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
    mutedForeground: "#66666F",
    subtleForeground: "#84848D",
    popover: "#FFFFFF",
    primaryForeground: "#FFFFFF",
    destructive: "#D23F3F",
    reading: "255 255 255",
    sidebar: "247 247 250",
    rail: "238 238 243",
    glass: "255 255 255",
    code: "rgb(28 28 34 / 0.04)",
    wall: "#E6E6EA",
    washes: [
      "rgb(255 255 255 / 0.9)",
      "rgb(205 207 214 / 0.7)",
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
    mutedForeground: "#9A9A9A",
    subtleForeground: "#6E6E6E",
    popover: "#1B1B1B",
    primaryForeground: "#0F0F0F",
    destructive: "#F07171",
    reading: "17 17 17",
    sidebar: "24 24 24",
    rail: "16 16 16",
    glass: "34 34 34",
    code: "rgb(0 0 0 / 0.3)",
    wall: "#0A0A0A",
    washes: [
      "rgb(255 255 255 / 0.05)",
      "rgb(140 140 140 / 0.1)",
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
    mutedForeground: "#9397A8",
    subtleForeground: "#666B7E",
    popover: "#161925",
    primaryForeground: "#0B0D14",
    destructive: "#F07A86",
    reading: "14 16 23",
    sidebar: "20 23 33",
    rail: "12 14 21",
    glass: "32 36 50",
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
    mutedForeground: "#A39E96",
    subtleForeground: "#76716A",
    popover: "#262421",
    primaryForeground: "#1A1917",
    destructive: "#F08070",
    reading: "28 27 25",
    sidebar: "36 34 31",
    rail: "24 23 21",
    glass: "52 50 46",
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
    mutedForeground: "#6E6860",
    subtleForeground: "#878078",
    popover: "#FFFDF8",
    primaryForeground: "#FFFDF8",
    destructive: "#C8423A",
    reading: "253 251 246",
    sidebar: "243 239 230",
    rail: "236 232 222",
    glass: "255 253 248",
    code: "rgb(60 50 30 / 0.05)",
    wall: "#E8E3D8",
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
    mutedForeground: "#9AA5B1",
    subtleForeground: "#6C7883",
    popover: "#2C323B",
    primaryForeground: "#22272E",
    destructive: "#E8818A",
    reading: "36 41 48",
    sidebar: "44 50 58",
    rail: "30 35 42",
    glass: "62 70 80",
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
    blue: "#3B74E0",
    violet: "#7A5BD6",
    teal: "#1E9C86",
    amber: "#C9711A",
    rose: "#D04A74",
    graphite: "#5A5A66",
  },
};

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
    "--card": dark ? ink(0.035) : "rgb(255 255 255 / 0.55)",
    "--secondary": ink(dark ? 0.07 : 0.06),
    "--muted": ink(dark ? 0.05 : 0.045),
    "--accent": ink(dark ? 0.06 : 0.05),
    "--border": ink(dark ? 0.075 : 0.08),
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
    "--sidebar-border": ink(dark ? 0.06 : 0.07),
    ...statusSets[seed.scheme],
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
    "--diff-add": dark ? "rgb(108 196 143 / 0.13)" : "rgb(46 154 94 / 0.12)",
    "--diff-del": dark ? "rgb(240 113 113 / 0.12)" : "rgb(210 63 63 / 0.1)",
    "--wall": seed.wall,
    "--w1": seed.washes[0],
    "--w2": seed.washes[1],
    "--w3": seed.washes[2],
    "--w4": seed.washes[3],
    "--radius-sm": "6px",
    "--radius": "8px",
    "--radius-lg": "12px",
    "--radius-xl": "16px",
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
export const defaultThemeId = "dark";

export function presetTheme(id: string): Theme | undefined {
  return presetThemes.find((theme) => theme.id === id);
}
/** The preset a custom theme falls back to for any token it does not set. */
export function basePreset(scheme: Scheme): Theme {
  const theme = presetTheme(scheme === "dark" ? "dark" : "light");
  if (!theme) throw new Error("Base presets are always defined");
  return theme;
}
