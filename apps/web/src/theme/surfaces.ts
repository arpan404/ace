import { contrastRatio, parseOpaqueColor, type Rgb } from "./colour.ts";
import type { Base, Scheme } from "./types.ts";

/*
 * Every surface text can sit on, as the browser composites it, so contrast checks hold where
 * text is actually drawn and not only on the page background: the opaque surfaces, glass over the
 * page, the sidebar and the two extremes any content can put behind it (white and black), and a
 * hovered or selected row's ink wash on top of each.
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

/**
 * The worst backdrops glass can sit over. Blur averages what's behind a layer, so the extremes
 * are a large block of white (a light image, a white page) and of black (a dark image, a
 * terminal): glass that keeps text legible over both keeps it legible over anything.
 */
export const backdropSamples: readonly Surface[] = [
  { name: "a white backdrop", rgb: [255, 255, 255] },
  { name: "a black backdrop", rgb: [0, 0, 0] },
];

/** The strongest ink wash under text: a selected row (`--fill-strong`). */
const selectedInk: Record<Scheme, number> = { light: 0.07, dark: 0.08 };

/** Glass never gets thinner than this, so the material reads the same calm way in every theme. */
const minimumTint = 0.72;
/**
 * What glass must hold over any backdrop: text and secondary text at WCAG AA (4.5:1); quiet
 * text (shortcut glyphs and hints that repeat what a label says) at 3:1. Over the theme's own
 * page and sidebar every level still reads at AA (`paletteSurfaces`, `contrast.ts`).
 */
export const glassTextLevels = [
  { key: "t1", minimum: 4.5 },
  { key: "t2", minimum: 4.5 },
  { key: "t3", minimum: 3 },
] as const;

/**
 * The glass tint's opacity: the thinnest tint of the floating colour (`s2`) over which every
 * text level (`t1`, `t2`, `t3`) still reads at AA on both backdrop samples, a selected row's
 * wash included. This is the adaptive part of the material, solved per theme and scheme when the
 * theme is built instead of sampled per frame. 1 when the theme has no glass.
 */
export function glassTintAlpha(
  palette: Pick<Base, "s2" | "t1" | "t2" | "t3" | "material">,
  scheme: Scheme,
): number {
  const glass = parseOpaqueColor(palette.s2);
  const ink = parseOpaqueColor(palette.t1);
  if (!palette.material.glass || !glass || !ink) return 1;
  const text = glassTextLevels.flatMap(({ key, minimum }) => {
    const rgb = parseOpaqueColor(palette[key]);
    return rgb ? [{ rgb, minimum }] : [];
  });
  for (let percent = Math.round(minimumTint * 100); percent < 100; percent++) {
    const alpha = percent / 100;
    const reads = backdropSamples.every((sample) => {
      const behind = over(glass, alpha, sample.rgb);
      const selected = over(ink, selectedInk[scheme], behind);
      return text.every(
        ({ rgb, minimum }) =>
          contrastRatio(rgb, behind) >= minimum && contrastRatio(rgb, selected) >= minimum,
      );
    });
    if (reads) return alpha;
  }
  return 1;
}

/** `palette` needs no accent: the accent is fitted to these surfaces. */
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
  // The theme's own content behind glass; the white and black extremes are `glassTintAlpha`'s.
  const under = solid.filter((surface) => surface.name === "page" || surface.name === "sidebar");
  const glassy: Surface[] =
    glass && palette.material.glass
      ? under.map((surface) => ({
          name: `glass over ${surface.name}`,
          rgb: over(glass, palette.glassTint, surface.rgb),
        }))
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
