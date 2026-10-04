import { contrastRatio } from "@/theme/contrast.ts";

/*
 * The terminal's colours, derived from the theme rather than picked per theme: the six ANSI
 * hues are ace's status colours (the same reds and greens a person already reads as failed and
 * done), black and white come from the surface and the text ramp, and every colour a program
 * prints as text is nudged until it reads on the terminal's background. Pure, so a custom
 * theme gets a coherent palette without anyone writing one.
 */

export type Rgb = readonly [number, number, number];

export interface PaletteInput {
  /** The surface the terminal sits on, already composited to an opaque colour. */
  background: Rgb;
  foreground: Rgb;
  muted: Rgb;
  subtle: Rgb;
  red: Rgb;
  green: Rgb;
  yellow: Rgb;
  blue: Rgb;
  magenta: Rgb;
  cyan: Rgb;
  /** The accent ring: selection is a wash of it. */
  ring: Rgb;
}

export const ansiNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type AnsiName = (typeof ansiNames)[number];

export type TerminalPalette = Record<AnsiName, string> & {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
};

/** Text a program colours must reach this contrast on the background (WCAG large/UI text). */
export const minimumTextContrast = 3;

const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

/** `a` moved toward `b` by `t` (0..1), in sRGB. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    clamp(a[0] + (b[0] - a[0]) * t),
    clamp(a[1] + (b[1] - a[1]) * t),
    clamp(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Paint a translucent colour over an opaque one. */
export function over(top: readonly [number, number, number, number], under: Rgb): Rgb {
  const alpha = top[3] / 255;
  return mix(under, [top[0], top[1], top[2]], alpha);
}

const css = ([r, g, b]: Rgb, alpha = 1) =>
  alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;

/** Is this a dark surface (light text on it)? */
export function isDark(background: Rgb): boolean {
  return contrastRatio(background, [0, 0, 0]) < contrastRatio(background, [255, 255, 255]);
}

/**
 * `color`, moved step by step toward the readable end (white on dark, black on light) until it
 * reaches `minimum` contrast on `background`. Already readable colours come back unchanged.
 */
export function readable(color: Rgb, background: Rgb, minimum = minimumTextContrast): Rgb {
  const target: Rgb = isDark(background) ? [255, 255, 255] : [0, 0, 0];
  let current = color;
  for (let step = 1; step <= 20 && contrastRatio(current, background) < minimum; step++)
    current = mix(color, target, step / 20);
  return current;
}

/** The sixteen ANSI colours plus the terminal's chrome colours for this theme. */
export function terminalPalette(input: PaletteInput): TerminalPalette {
  const { background: bg, foreground: fg } = input;
  const dark = isDark(bg);
  const text = (color: Rgb) => css(readable(color, bg));
  // Bright variants lean toward the text colour: lighter on dark themes, deeper on light ones.
  const bright = (color: Rgb) => text(mix(color, fg, 0.28));
  const hues = {
    red: input.red,
    green: input.green,
    yellow: input.yellow,
    blue: input.blue,
    magenta: input.magenta,
    cyan: input.cyan,
  };
  return {
    background: css(bg),
    // Calm by default: a touch under full ink, so coloured output still stands out.
    foreground: text(mix(fg, input.muted, 0.18)),
    cursor: css(fg),
    cursorAccent: css(bg),
    selectionBackground: css(input.ring, dark ? 0.32 : 0.24),
    selectionInactiveBackground: css(fg, dark ? 0.14 : 0.1),
    // Black is mostly a background colour; on light themes programs use it as ink.
    black: dark ? css(mix(bg, fg, 0.22)) : text(fg),
    red: text(hues.red),
    green: text(hues.green),
    yellow: text(hues.yellow),
    blue: text(hues.blue),
    magenta: text(hues.magenta),
    cyan: text(hues.cyan),
    white: dark ? text(input.muted) : css(mix(bg, fg, 0.3)),
    brightBlack: text(input.subtle),
    brightRed: bright(hues.red),
    brightGreen: bright(hues.green),
    brightYellow: bright(hues.yellow),
    brightBlue: bright(hues.blue),
    brightMagenta: bright(hues.magenta),
    brightCyan: bright(hues.cyan),
    brightWhite: dark ? css(fg) : css(mix(bg, fg, 0.12)),
  };
}
