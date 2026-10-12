import { parseOpaqueColor, type Rgb } from "./colour.ts";
import type { Palette, Scheme } from "./palettes.ts";

/*
 * Every surface text can sit on, as the browser composites it, so contrast checks hold where
 * text is actually drawn and not only on the page background: the opaque surfaces, translucent
 * glass (both the blur and the liquid tint) over the page and the sidebar, and a hovered or
 * selected row's ink wash on top of each.
 */

export interface Surface {
  name: string;
  rgb: Rgb;
}

/** `top` at `alpha` over `under`, per channel in sRGB as the browser blends. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i]! * alpha + under[i]! * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

/** The tint alphas in tokens.ts: blur glass, then the thinner liquid glass. */
const glassAlpha: Record<Scheme, { blur: number; liquid: number }> = {
  light: { blur: 0.6, liquid: 0.46 },
  dark: { blur: 0.58, liquid: 0.44 },
};
/** The strongest ink wash under text: a selected row (`--fill-strong`). */
const selectedInk: Record<Scheme, number> = { light: 0.07, dark: 0.08 };

export function paletteSurfaces(palette: Palette, scheme: Scheme): Surface[] {
  const solid: Surface[] = [];
  const add = (name: string, value: string) => {
    const rgb = parseOpaqueColor(value);
    if (rgb) solid.push({ name, rgb });
  };
  add("page", palette.s0);
  add("raised", palette.s1);
  add("floating", palette.s2);
  add("sidebar", palette.sidebar);
  add("code", palette.code);
  const glass = parseOpaqueColor(palette.s2);
  const under = solid.filter((surface) => surface.name === "page" || surface.name === "sidebar");
  const alphas = glassAlpha[scheme];
  const glassy: Surface[] = glass
    ? under.flatMap((surface) => [
        { name: `glass over ${surface.name}`, rgb: over(glass, alphas.blur, surface.rgb) },
        { name: `liquid glass over ${surface.name}`, rgb: over(glass, alphas.liquid, surface.rgb) },
      ])
    : [];
  const ink = parseOpaqueColor(palette.t1);
  const all = [...solid, ...glassy];
  const selected = ink
    ? all.map((surface) => ({
        name: `selected on ${surface.name}`,
        rgb: over(ink, selectedInk[scheme], surface.rgb),
      }))
    : [];
  return [...all, ...selected];
}
