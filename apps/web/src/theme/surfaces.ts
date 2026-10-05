import { parseOpaqueColor, type Rgb } from "./colour.ts";
import type { ThemeTokens } from "./tokens.ts";

/*
 * Every surface text can sit on, as the browser composites it, so contrast checks hold where
 * text is actually drawn and not only on the page background. Covers both glass extremes: solid
 * (glass intensity 0 or Reduce transparency) and fully clear, where the rail, sidebar, reading
 * column and floating glass show the wallpaper through their own alpha (tokens.css). Rows and
 * tabs add the strongest ink wash (10%) on top of the surface under them.
 */

export interface Surface {
  name: string;
  rgb: Rgb;
}

const triple = (value: string | undefined): Rgb | undefined =>
  value === undefined ? undefined : parseOpaqueColor(`rgb(${value})`);

/** `top` at `alpha` over `under`, per channel in sRGB as the browser blends. */
function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** The strongest ink wash text sits on: a selected nav item (`bg-foreground/10`). */
const selectedInk = 0.1;
/** How much each material lets the wallpaper through at full glass intensity (tokens.css). */
const clear = { sidebar: 0.5, reading: 0.1 } as const;

export function themeSurfaces(tokens: ThemeTokens): Surface[] {
  const ink = parseOpaqueColor(tokens["--foreground"]);
  const wall = parseOpaqueColor(tokens["--wall"]);
  const glassAlpha = Number(tokens["--glass-a"]);
  const solid: Surface[] = [];
  const add = (name: string, rgb: Rgb | undefined) => {
    if (rgb) solid.push({ name, rgb });
  };
  add("page", parseOpaqueColor(tokens["--background"]));
  add("popover", parseOpaqueColor(tokens["--popover"]));
  // The rail carries icons only, never text, so it is not a text surface.
  const materials = {
    sidebar: triple(tokens["--sidebar-rgb"]),
    reading: triple(tokens["--reading-rgb"]),
  };
  for (const [name, rgb] of Object.entries(materials)) {
    add(name, rgb);
    if (rgb && wall) add(`clear ${name}`, over(rgb, 1 - clear[name as keyof typeof clear], wall));
  }
  const glass = triple(tokens["--glass-rgb"]);
  add("solid glass", glass);
  if (glass && Number.isFinite(glassAlpha))
    for (const [name, under] of [
      ["wallpaper", wall],
      ["reading", materials.reading],
      ["sidebar", materials.sidebar],
    ] as const)
      if (under) add(`clear glass over ${name}`, over(glass, glassAlpha, under));
  const selected = ink
    ? solid.map((surface) => ({
        name: `selected on ${surface.name}`,
        rgb: over(ink, selectedInk, surface.rgb),
      }))
    : [];
  return [...solid, ...selected];
}
