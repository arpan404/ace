import {
  contrastRatio,
  deltaE,
  oklchToHex,
  parseOpaqueColor,
  readableAcross,
  rgbToOklch,
  type Rgb,
} from "./colour.ts";
import { sharedStatus } from "./status.ts";
import { paletteSurfaces } from "./surfaces.ts";
import type { Accent, Base, Scheme } from "./types.ts";

/*
 * One accent colour fitted to one theme's palette. Whatever colour a person picks, the result
 * is usable: labels on its fill read at AA in every state, its marks stand out from the page at
 * 3:1, its links read at AA on every surface, and it never passes for a status colour.
 */

/** Below this distance from a status colour an accent reads as that status (`deltaE`). */
export const statusDistance = 10;

const white: Rgb = [255, 255, 255];
const step = 0.01;
/** Lightness steps between the accent and its hovered and pressed fills. */
const stateStep = 0.035;
/** How much deeper a light theme's fill may go for white labels before it takes a deep one. */
const maxDeepen = 0.15;

interface Oklch {
  l: number;
  c: number;
  h: number;
}
const hex = ({ l, c, h }: Oklch) => oklchToHex(Math.min(1, Math.max(0, l)), c, h);
const rgb = (value: string): Rgb => parseOpaqueColor(value) ?? white;

/** The fills of an accent at one hue, before its text colour. */
interface Fills {
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentFg: string;
}

/**
 * Light themes take white labels: the fill darkens until white reads on it, and hover and
 * press darken further. Dark themes take a deep label in the accent's own hue: the fill
 * lightens until that reads on its darkest (pressed) state and the fill stands out from the
 * page; hover and the resting fill sit above it.
 */
function fills(colour: Oklch, scheme: Scheme, page: Rgb): Fills {
  const label = hex({ l: 0.18, c: Math.min(colour.c, 0.04), h: colour.h });
  const ink = rgb(label);
  if (scheme === "light") {
    let l = colour.l;
    while (l > 0 && contrastRatio(white, rgb(hex({ ...colour, l }))) < 4.6) l -= step;
    if (colour.l - l <= maxDeepen)
      return {
        accent: hex({ ...colour, l }),
        accentHover: hex({ ...colour, l: l - stateStep }),
        accentPressed: hex({ ...colour, l: l - 2 * stateStep }),
        accentFg: "#FFFFFF",
      };
    // A bright colour (amber, lime) would turn muddy deep enough for white labels: it keeps its
    // brightness, as far as marks stand out from the page, and takes a deep label instead.
    l = colour.l;
    while (l > 0 && contrastRatio(rgb(hex({ ...colour, l })), page) < 3) l -= step;
    return {
      accent: hex({ ...colour, l }),
      accentHover: hex({ ...colour, l: l + stateStep }),
      accentPressed: hex({ ...colour, l: l + 2 * stateStep }),
      accentFg: label,
    };
  }
  const reads = (l: number) => {
    const fill = rgb(hex({ ...colour, l }));
    return contrastRatio(ink, fill) >= 4.6 && contrastRatio(fill, page) >= 3;
  };
  let pressed = colour.l - stateStep;
  while (pressed < 1 && !reads(pressed)) pressed += step;
  return {
    accent: hex({ ...colour, l: pressed + stateStep }),
    accentHover: hex({ ...colour, l: pressed + 2 * stateStep }),
    accentPressed: hex({ ...colour, l: pressed }),
    accentFg: label,
  };
}

/** Every status mark of a scheme: an accent near one of them would read as that status. */
function statusMarks(palette: Base, scheme: Scheme): Rgb[] {
  const shared = sharedStatus[scheme];
  return [
    palette.working,
    palette.needs,
    palette.failed,
    palette.done,
    shared.waiting,
    shared.unresponsive,
  ].map(rgb);
}

/** How far `colour` is from the nearest status mark. */
export function statusGap(colour: string, palette: Base, scheme: Scheme): number {
  const mark = rgb(colour);
  return Math.min(...statusMarks(palette, scheme).map((status) => deltaE(mark, status)));
}

/** Whether `colour` lands so near a status colour on `palette` that `deriveAccent` moves it. */
export function nearStatus(colour: string, scheme: Scheme, palette: Base): boolean {
  const start = rgbToOklch(rgb(colour));
  const fitted = fills(start, scheme, rgb(palette.s0));
  return start.c > 0.03 && statusGap(fitted.accent, palette, scheme) < statusDistance;
}

/**
 * Small moves away from a status colour, nearest first: a few degrees of hue either way, and a
 * step deeper (light themes) or brighter (dark themes), which keeps labels readable.
 */
const nudges: readonly { turn: number; depth: number }[] = [-30, -20, -12, -6, 0, 6, 12, 20, 30]
  .flatMap((turn) => [0, 1, 2, 3, 4].map((depth) => ({ turn, depth })))
  .filter((nudge) => nudge.turn !== 0 || nudge.depth !== 0)
  .toSorted((a, b) => Math.abs(a.turn) / 6 + a.depth - (Math.abs(b.turn) / 6 + b.depth));

/**
 * The accent's tokens for `colour` on `palette`. A colour that lands within `statusDistance`
 * of a status is nudged (`nudges`) to the nearest variant that doesn't; greys never need to.
 */
export function deriveAccent(colour: string, scheme: Scheme, palette: Base): Accent {
  const start = rgbToOklch(rgb(colour));
  const page = rgb(palette.s0);
  let chosen = fills(start, scheme, page);
  if (nearStatus(colour, scheme, palette)) {
    const direction = scheme === "light" ? -1 : 1;
    for (const { turn, depth } of nudges) {
      const fitted = fills(
        { ...start, h: (start.h + turn + 360) % 360, l: start.l + direction * depth * 0.04 },
        scheme,
        page,
      );
      if (statusGap(fitted.accent, palette, scheme) >= statusDistance) {
        chosen = fitted;
        break;
      }
    }
  }
  const surfaces = paletteSurfaces(palette, scheme).map((surface) => surface.rgb);
  return {
    ...chosen,
    accentText: readableAcross(chosen.accent, surfaces, scheme === "dark") ?? palette.t1,
  };
}
