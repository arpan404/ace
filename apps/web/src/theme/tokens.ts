import { oklchToHex } from "./colour.ts";
import { rampSteps, sharedStatus, type Palette, type Scheme } from "./palettes.ts";

/*
 * One palette as every themed CSS variable. Components read these names only (through the
 * Tailwind utilities in styles/index.css); docs/design/visual-language.md lists what each is for.
 * Status `-text` colours for waiting and not-responding are added in `css.ts`, where they are
 * made readable across the theme's surfaces.
 */

/** "#RRGGBB" as "r g b", for the old `rgb(var(--x-rgb))` names. */
const rgbTriple = (hex: string) =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(" ");

/** An alpha as a whole percent. */
const pct = (alpha: number) => Math.round(alpha * 100);

/** `colour` at `percent` over transparent. */
const wash = (colour: string, percent: number) =>
  `color-mix(in srgb, ${colour} ${percent}%, transparent)`;

/**
 * Project badge tints: twelve hues around the wheel at one perceptual lightness per scheme, so
 * no project looks louder than another. Each reads as text on the theme's surfaces (AA).
 */
const projectHues = [25, 55, 85, 125, 150, 178, 205, 240, 268, 295, 325, 355] as const;
const projectLightness: Record<Scheme, { l: number; c: number }> = {
  dark: { l: 0.85, c: 0.12 },
  light: { l: 0.41, c: 0.14 },
};
const projectTints = (scheme: Scheme): Record<`--project-${number}`, string> => {
  const { l, c } = projectLightness[scheme];
  return Object.fromEntries(
    projectHues.map((hue, index) => [`--project-${index + 1}`, oklchToHex(l, c, hue)]),
  );
};
const projectSets: Record<Scheme, Record<`--project-${number}`, string>> = {
  light: projectTints("light"),
  dark: projectTints("dark"),
};

/**
 * Chart series for published HTML visualizations (@ace/html `themeProperties`): blue, red,
 * green, magenta, amber and cyan, 55–60° apart at one lightness per scheme, so each is distinct
 * from the others and reads on the theme's background.
 */
const chartHues = [260, 30, 145, 330, 85, 200] as const;
const chartLightness: Record<Scheme, { l: number; c: number }> = {
  dark: { l: 0.78, c: 0.14 },
  light: { l: 0.55, c: 0.16 },
};
const chartSets: Record<Scheme, Record<string, string>> = {
  light: chartSeries("light"),
  dark: chartSeries("dark"),
};
function chartSeries(scheme: Scheme): Record<string, string> {
  const { l, c } = chartLightness[scheme];
  return Object.fromEntries(
    chartHues.map((hue, index) => [`--chart-${index + 1}`, oklchToHex(l, c, hue)]),
  );
}

/** `--neutral-1` … `--neutral-12`, in ramp order (palettes.ts `rampSteps`). */
function neutralRamp(p: Palette): Record<`--neutral-${number}`, string> {
  return Object.fromEntries(rampSteps.map((step, index) => [`--neutral-${index + 1}`, p[step]]));
}

export function themeTokens(p: Palette, scheme: Scheme) {
  const light = scheme === "light";
  const sx = p.syntax;
  const status = sharedStatus[scheme];
  const fill = wash(p.t1, light ? 4 : 5);
  const fillStrong = wash(p.t1, light ? 7 : 8);
  const floatShadow = light
    ? `0 1px 2px rgb(${p.shadow} / 0.05), 0 6px 16px -4px rgb(${p.shadow} / 0.1), 0 22px 48px -18px rgb(${p.shadow} / 0.2)`
    : "0 1px 2px rgb(0 0 0 / 0.4), 0 8px 20px -6px rgb(0 0 0 / 0.45), 0 28px 56px -20px rgb(0 0 0 / 0.6)";
  // The specular rim, lit from above: a bright crescent along the top edge (an offset inset
  // shadow follows the corners and tapers down them), a faint hairline all round, and a weaker
  // return along the bottom where the light leaves the glass.
  const glassRim = light
    ? "inset 0 1px 0 0 rgb(255 255 255 / 0.95), inset 0 0 0 1px rgb(255 255 255 / 0.4), inset 0 -1px 0 0 rgb(255 255 255 / 0.3)"
    : "inset 0 1px 0 0 rgb(255 255 255 / 0.16), inset 0 0 0 1px rgb(255 255 255 / 0.06), inset 0 -1px 0 0 rgb(255 255 255 / 0.04)";
  const glass = p.material.glass;
  return {
    // The neutral ramp, by step (`--neutral-1` canvas … `--neutral-12` text).
    ...neutralRamp(p),

    // Surfaces.
    "--surface-0": p.s0,
    "--surface-1": p.s1,
    "--surface-2": p.s2,
    "--background": p.s0,
    "--reading": p.s0,
    "--sidebar": p.sidebar,
    "--panel": p.sidebar,
    "--popover": p.s2,
    "--card": p.s1,
    "--bubble": p.s1,
    "--code": p.code,
    "--fill": fill,
    "--fill-strong": fillStrong,
    "--secondary": wash(p.t1, light ? 6 : 8),
    "--muted": fill,
    "--accent": fill,
    "--hover": p.hover,
    "--active": p.active,
    "--border": p.border,
    "--border-soft": `color-mix(in srgb, ${p.border} 70%, transparent)`,
    "--border-strong": p.borderStrong,
    "--input": p.borderStrong,
    // Text fields: white with a hairline in light, a quiet lift in dark; same on any surface.
    "--field": light ? p.raised : wash(p.t1, 6),
    "--faint-foreground": p.faint,
    // Modal backdrops: a light neutral scrim when solid, a barely-there tint over blur when glass.
    "--scrim": light ? `rgb(${p.shadow} / 0.14)` : "rgb(0 0 0 / 0.36)",
    "--scrim-glass": light ? "rgb(255 255 255 / 0.16)" : "rgb(0 0 0 / 0.18)",
    "--skel": wash(p.t1, light ? 6 : 8),
    "--skel-hi": wash(p.s0, light ? 70 : 12),

    // Text.
    "--foreground": p.t1,
    "--muted-foreground": p.t2,
    "--subtle-foreground": p.t3,
    "--primary": p.t1,
    "--primary-foreground": p.s0,
    "--destructive": p.failedText,
    "--sidebar-foreground": p.t1,
    "--sidebar-accent": fillStrong,
    "--sidebar-border": p.border,

    // The accent: focus, selection, primary actions, checked controls, links.
    "--ring": p.accent,
    "--ring-hover": p.accentHover,
    "--ring-pressed": p.accentPressed,
    "--ring-foreground": p.accentFg,
    "--ring-text": p.accentText,
    "--focus": `color-mix(in srgb, ${p.accent} ${p.material.focus}%, transparent)`,

    // Status hues (dots, rings) and the same hue as readable words.
    "--status-working": p.working,
    "--status-working-text": p.workingText,
    "--status-needs-you": p.needs,
    "--status-needs-you-text": p.needsText,
    "--status-failed": p.failed,
    "--status-failed-text": p.failedText,
    "--status-done": p.done,
    "--status-done-text": p.doneText,
    "--status-waiting": status.waiting,
    "--status-unresponsive": status.unresponsive,

    // Diffs and code.
    "--diff-add": p.diffAdd,
    "--diff-add-text": p.diffAddFg,
    "--diff-del": p.diffDel,
    "--diff-del-text": p.diffDelFg,
    "--syn-kw": sx.kw,
    "--syn-str": sx.str,
    "--syn-num": sx.num,
    "--syn-fn": sx.fn,
    "--syn-type": sx.type,
    "--syn-com": sx.com,
    "--syn-punc": sx.punc,

    // Controls.
    "--seg-bg": wash(p.t1, light ? 6 : 8),
    "--seg-thumb": light ? p.s2 : `color-mix(in srgb, ${p.s2}, #fff 9%)`,
    "--seg-thumb-shadow": light
      ? `0 0 0 0.5px rgb(${p.shadow} / 0.14), 0 1px 3px rgb(${p.shadow} / 0.12)`
      : "inset 0 1px 0 rgb(255 255 255 / 0.06), 0 1px 3px rgb(0 0 0 / 0.4)",
    "--switch-off": wash(p.t1, light ? 16 : 22),

    // Floating layers: solid edge and shadow, and the glass material (styles/glass.css).
    "--float-edge": light ? `color-mix(in srgb, ${p.border}, ${p.t1} 4%)` : p.border,
    "--float-shadow": floatShadow,
    // The tint is as thin as AA over a white or a black backdrop allows (`glassTintAlpha`).
    "--glass-tint": `color-mix(in srgb, ${p.s2} ${pct(p.glassTint)}%, transparent)`,
    "--glass-blur": `${glass?.blur ?? 0}px`,
    "--glass-saturate": `${glass?.saturate ?? 100}%`,
    "--glass-rim": glassRim,
    // A hairline just outside the rim, so the layer's silhouette holds over its own colour.
    "--glass-edge": light ? `rgb(${p.shadow} / 0.12)` : "rgb(0 0 0 / 0.55)",
    "--glass-shadow": floatShadow,
    "--glass-border": light ? `rgb(${p.shadow} / 0.1)` : "rgb(255 255 255 / 0.09)",
    "--glass-highlight": glassRim,
    "--sliver": light
      ? `color-mix(in srgb, ${p.s2} 80%, ${p.s1})`
      : `color-mix(in srgb, ${p.s2}, ${p.s1} 30%)`,

    ...projectSets[scheme],
    ...chartSets[scheme],

    // Old names (styles/legacy-aliases.css explains when they go).
    "--accent-theme": p.accent,
    "--reading-rgb": rgbTriple(p.s0),
    "--sidebar-rgb": rgbTriple(p.sidebar),
    "--glass-rgb": rgbTriple(p.s2),
  };
}

export type ThemeTokens = ReturnType<typeof themeTokens>;

/** How many project tints a theme has; `--project-1` to `--project-${projectTintCount}`. */
export const projectTintCount = projectHues.length;
