import { rgba } from "@/lib/css-color.ts";
import { over, terminalPalette, type Rgb, type TerminalPalette } from "./palette.ts";
import { defaultTerminalLook, terminalReveal, type TerminalLook } from "./suit-terminal.ts";

/*
 * The live theme's tokens, resolved to plain colours for xterm's renderers (which can't read
 * CSS variables), turned into the terminal palette.
 */

const token = (style: CSSStyleDeclaration, name: string) => style.getPropertyValue(name).trim();

function opaque(style: CSSStyleDeclaration, name: string, under: Rgb, fallback: string): Rgb {
  return over(rgba(token(style, name) || fallback), under);
}

/** The colour actually painted behind `element`: the first ancestor that paints one. */
function surface(element: Element, base: Rgb): Rgb {
  const layers: [number, number, number, number][] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const layer = rgba(getComputedStyle(node).backgroundColor);
    if (layer[3] === 0) continue;
    layers.push(layer);
    if (layer[3] === 255) break;
  }
  return layers.reduceRight<Rgb>((under, layer) => over(layer, under), base);
}

export interface XtermColours extends TerminalPalette {
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
}

/**
 * xterm's colours for `element` under `look` (the Suit's terminal, `suit-terminal.ts`): its
 * background, or the colour painted behind the terminal, with everything the Suit leaves unset
 * derived from the theme. With a reveal, the background is drawn that much transparent, so the
 * panel's own background or scene shows behind the text (xterm needs `allowTransparency`).
 */
export function themeFor(element: Element, look: TerminalLook = defaultTerminalLook): XtermColours {
  const style = getComputedStyle(element);
  const base = over(rgba(token(style, "--background") || "#0f0f0f"), [15, 15, 15]);
  const behind = surface(element, base);
  const background = look.background ? over(look.background, behind) : behind;
  const color = (name: string, fallback: string) => opaque(style, name, background, fallback);
  const foreground = color("--foreground", "#ececec");
  const palette = terminalPalette(
    {
      background,
      foreground,
      muted: color("--muted-foreground", "#9a9a9a"),
      subtle: color("--subtle-foreground", "#6e6e6e"),
      red: color("--status-failed", "#f07171"),
      green: color("--status-done", "#6cc48f"),
      yellow: color("--status-needs-you", "#f0a35e"),
      blue: color("--status-working", "#7aa2f7"),
      magenta: color("--status-waiting", "#b49cf5"),
      cyan: color("--syn-type", "#6ccfd8"),
      ring: color("--ring", "#7aa2f7"),
    },
    look.colours,
  );
  const reveal = terminalReveal(look, background, look.colours.foreground ?? foreground);
  const ink = (alpha: number) =>
    `rgba(${foreground[0]}, ${foreground[1]}, ${foreground[2]}, ${alpha})`;
  return {
    ...palette,
    background:
      reveal > 0
        ? `rgba(${background[0]}, ${background[1]}, ${background[2]}, ${1 - reveal})`
        : palette.background,
    scrollbarSliderBackground: ink(0.14),
    scrollbarSliderHoverBackground: ink(0.22),
    scrollbarSliderActiveBackground: ink(0.3),
  };
}
