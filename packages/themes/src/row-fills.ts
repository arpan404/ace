import { deltaE, oklchToHex, parseOpaqueColor, rgbToOklab, type Rgb } from "./colour.ts";

/*
 * The row fills (hover, and the open or picked row) must show on the surface the rows sit on:
 * the sidebar's panel, a mix of the page and the sidebar (`--sidebar-panel`). A light theme's
 * designed fills sit within a just-noticeable step of it, so an open row barely shows. A fill
 * already far enough from the panel keeps its designed value exactly; one that isn't steps
 * toward the theme's text, in OKLab, just far enough. Pure.
 */

/** How far each fill must sit from the panel (`deltaE`; about 2 is just noticeable). */
export const rowFillDistance = { hover: 2.5, active: 5.5 } as const;

/** The panel the rows sit on: 30% page over the sidebar, in OKLab, as `--sidebar-panel` mixes. */
export function sidebarPanel(canvas: string, sidebar: string): string {
  const [page, side] = [opaque(canvas), opaque(sidebar)];
  return labToHex(mixLab(rgbToOklab(page), rgbToOklab(side), 0.3));
}

/** `fill`, or the first step from the panel toward `text` that sits `distance` away from it. */
export function visibleFill(fill: string, panel: string, text: string, distance: number): string {
  const base = opaque(panel);
  if (deltaE(opaque(fill), base) >= distance) return fill;
  const [from, to] = [rgbToOklab(base), rgbToOklab(opaque(text))];
  for (let step = 1; step <= 100; step++) {
    const candidate = labToHex(mixLab(to, from, step / 100));
    if (deltaE(opaque(candidate), base) >= distance) return candidate;
  }
  return text;
}

/** A source's hover and active fills, each made to show on the sidebar's panel. */
export function rowFills(source: {
  canvas: string;
  sidebar: string;
  text: string;
  hover: string;
  active: string;
}): { hover: string; active: string } {
  const panel = sidebarPanel(source.canvas, source.sidebar);
  return {
    hover: visibleFill(source.hover, panel, source.text, rowFillDistance.hover),
    active: visibleFill(source.active, panel, source.text, rowFillDistance.active),
  };
}

type Lab = [number, number, number];

/** `a` at `t` over `b`. */
const mixLab = (a: Lab, b: Lab, t: number): Lab => [
  a[0] * t + b[0] * (1 - t),
  a[1] * t + b[1] * (1 - t),
  a[2] * t + b[2] * (1 - t),
];

function labToHex([l, a, b]: Lab): string {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return oklchToHex(l, Math.hypot(a, b), h < 0 ? h + 360 : h);
}

function opaque(colour: string): Rgb {
  const rgb = parseOpaqueColor(colour);
  if (!rgb) throw new Error(`Row fills need opaque colours: ${colour}`);
  return rgb;
}
