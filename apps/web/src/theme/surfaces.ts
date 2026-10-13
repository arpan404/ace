import { parseOpaqueColor, type Rgb } from "./colour.ts";
import type { Base, Scheme } from "./types.ts";

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

/** The strongest ink wash under text: a selected row (`--fill-strong`). */
const selectedInk: Record<Scheme, number> = { light: 0.07, dark: 0.08 };

/**
 * `palette` needs no accent: the accent is fitted to these surfaces. Glass alphas are the
 * theme's material (`--glass-tint` and `--glass-tint-liquid` in tokens.ts).
 */
export function paletteSurfaces(palette: Base, scheme: Scheme): Surface[] {
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
  const alphas = palette.material.glass;
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
  // Solid hover and active fills are the highlighted state themselves; no wash goes on them.
  const states = [palette.hover, palette.active].flatMap((value, index) => {
    const rgb = parseOpaqueColor(value);
    return rgb ? [{ name: index === 0 ? "hover" : "active", rgb }] : [];
  });
  return [...all, ...selected, ...states];
}
