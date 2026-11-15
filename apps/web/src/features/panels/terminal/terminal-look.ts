import { useMemo } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";
import { terminalFont, terminalFontFamily } from "./fonts.ts";
import { terminalLook, type TerminalLook } from "./suit-terminal.ts";
import type { XtermColours } from "./xterm-theme.ts";

/** The terminal's look under the Suit and scheme on screen; ace's own look without a Suit. */
export function useTerminalLook(): TerminalLook {
  const { suit, resolved } = useTheme();
  return useMemo(() => terminalLook(suit, resolved.scheme), [suit, resolved.scheme]);
}

/** The font stack a terminal draws `look` with: the Suit's family first, then the app's monospace. */
export function lookFont(element: Element, look: TerminalLook): string {
  return look.fontFamily
    ? terminalFontFamily(
        `${look.fontFamily}, ${getComputedStyle(element).fontFamily || "monospace"}`,
      )
    : terminalFont(element);
}

/** A cell's width for `look`, near enough to size the PTY before anything is drawn. */
export const cellWidth = (look: TerminalLook) => look.fontSize * 0.6 + look.letterSpacing;

/**
 * The DOM screen's inline style (CSS property names) under `look` (used where WebGL is missing): the font, size, row
 * height and spacing xterm would use, its background and text, and each ANSI hue as a
 * `--term-<name>` variable its coloured runs read. Only the font is set for ace's own look, so
 * the screen keeps the theme's quieter text.
 */
export function screenStyle(
  look: TerminalLook,
  font: string,
  colours: XtermColours | undefined,
): Record<string, string> {
  const style: Record<string, string> = { "font-family": font };
  if (!colours) return style;
  style["font-size"] = `${look.fontSize}px`;
  style["line-height"] = `${look.row}px`;
  style["letter-spacing"] = `${look.letterSpacing}px`;
  style.color = colours.foreground;
  style["background-color"] = colours.background;
  style["--term-row"] = `${look.row}px`;
  style["--term-ink"] = colours.foreground;
  style["--term-dim"] = colours.brightBlack;
  style["--term-mark"] = colours.selectionBackground;
  for (const name of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const)
    style[`--term-${name}`] = colours[name];
  return style;
}
