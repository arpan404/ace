import { rgba } from "@/lib/css-color.ts";
import { over, terminalPalette, type Rgb, type TerminalPalette } from "./palette.ts";

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

export function themeFor(element: Element): XtermColours {
  const style = getComputedStyle(element);
  const base = over(rgba(token(style, "--background") || "#0f0f0f"), [15, 15, 15]);
  const background = surface(element, base);
  const color = (name: string, fallback: string) => opaque(style, name, background, fallback);
  const foreground = color("--foreground", "#ececec");
  const palette = terminalPalette({
    background,
    foreground,
    muted: color("--muted-foreground", "#9a9a9a"),
    subtle: color("--subtle-foreground", "#6e6e6e"),
    red: color("--status-failed", "#f07171"),
    green: color("--status-done", "#6cc48f"),
    yellow: color("--status-needs-you", "#f0a35e"),
    blue: color("--status-working", "#7aa2f7"),
    magenta: color("--status-waiting", "#b49cf5"),
    cyan: color("--accent-teal", "#5fc7b3"),
    ring: color("--ring", "#7aa2f7"),
  });
  const ink = (alpha: number) =>
    `rgba(${foreground[0]}, ${foreground[1]}, ${foreground[2]}, ${alpha})`;
  return {
    ...palette,
    scrollbarSliderBackground: ink(0.14),
    scrollbarSliderHoverBackground: ink(0.22),
    scrollbarSliderActiveBackground: ink(0.3),
  };
}
