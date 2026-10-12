import { oklchToHex } from "./colour.ts";
import { sharedStatus, syntax, type Palette, type Scheme } from "./palettes.ts";

/*
 * One palette as every themed CSS variable. Components read these names only (through the
 * Tailwind utilities in styles/index.css); docs/design/visual-language.md lists what each is for.
 * Status `-text` colours for waiting and not-responding are added in `css.ts`, where they are
 * made readable across the theme's surfaces.
 */

/** "#RRGGBB" as "r g b", for the old `rgb(var(--x-rgb))` names. */
const rgbTriple = (hex: string) =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(" ");

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

export function themeTokens(p: Palette, scheme: Scheme) {
  const light = scheme === "light";
  const sx = syntax[scheme];
  const status = sharedStatus[scheme];
  const fill = wash(p.t1, light ? 4 : 5);
  const fillStrong = wash(p.t1, light ? 7 : 8);
  const floatShadow = light
    ? `0 1px 2px rgb(${p.shadow} / 0.05), 0 6px 16px -4px rgb(${p.shadow} / 0.1), 0 22px 48px -18px rgb(${p.shadow} / 0.2)`
    : "0 1px 2px rgb(0 0 0 / 0.4), 0 8px 20px -6px rgb(0 0 0 / 0.45), 0 28px 56px -20px rgb(0 0 0 / 0.6)";
  const glassInner = light ? "rgb(255 255 255 / 0.85)" : "rgb(255 255 255 / 0.1)";
  return {
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
    "--border": p.border,
    "--border-soft": `color-mix(in srgb, ${p.border} 70%, transparent)`,
    "--border-strong": `color-mix(in srgb, ${p.border}, ${p.t1} 12%)`,
    "--input": `color-mix(in srgb, ${p.border}, ${p.t1} 12%)`,
    "--scrim": light ? `rgb(${p.shadow} / 0.16)` : "rgb(0 0 0 / 0.42)",
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
    "--focus": `color-mix(in srgb, ${p.accent} 60%, transparent)`,

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
    "--diff-add": wash(p.done, light ? 11 : 14),
    "--diff-del": wash(p.failed, light ? 10 : 14),
    "--syn-kw": sx.kw,
    "--syn-str": sx.str,
    "--syn-num": sx.num,
    "--syn-fn": sx.fn,
    "--syn-type": sx.type,
    "--syn-com": sx.com,

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
    "--glass-tint": `color-mix(in srgb, ${p.s2} ${light ? 60 : 58}%, transparent)`,
    "--glass-tint-liquid": `color-mix(in srgb, ${p.s2} ${light ? 46 : 44}%, transparent)`,
    "--glass-edge": light ? `rgb(${p.shadow} / 0.1)` : "rgb(255 255 255 / 0.09)",
    "--glass-inner": glassInner,
    "--glass-sheen": light ? "rgb(255 255 255 / 0.35)" : "rgb(255 255 255 / 0.045)",
    "--glass-shadow": floatShadow,
    "--glass-border": light ? `rgb(${p.shadow} / 0.1)` : "rgb(255 255 255 / 0.09)",
    "--glass-highlight": `inset 0 1px 0 ${glassInner}`,
    "--sliver": light
      ? `color-mix(in srgb, ${p.s2} 80%, ${p.s1})`
      : `color-mix(in srgb, ${p.s2}, ${p.s1} 30%)`,

    ...projectSets[scheme],

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
