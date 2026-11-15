import type { SuitManifest } from "@ace/protocol/suits";
import type { SuitRegion } from "@ace/protocol/suit-parts";
import { contrastRatio, over, parseOpaqueColor, type Rgb } from "@ace/themes";

/*
 * How much of a Suit's scene or background shows through each region's surface
 * (`SuitManifest.reveal`, ADR 0150), held to what keeps the region's text readable. Pure, so the
 * client draws with it and the live check can test a value against the frames it sampled.
 */

/**
 * What each region shows without a `reveal`: the look ace had before regions were tunable. The
 * frame (rail, top bar, the window behind the sidebar) lets 65% of a scene through, the
 * transcript 30%; the sidebar's panel, the composer and the side panel stay solid; a full page shows 30% like the transcript.
 */
export const defaultSuitReveal: Readonly<Record<SuitRegion, number>> = {
  app: 0.65,
  rail: 0.65,
  header: 0.65,
  sidebar: 0,
  transcript: 0.3,
  composer: 0,
  "right-panel": 0,
  page: 0.3,
};

/** Body text's WCAG floor. */
export const revealMinContrast = 4.5;

/** The darkest and lightest a backdrop can be, when no frame of it has been sampled. */
const extremes: readonly Rgb[] = [
  [0, 0, 0],
  [255, 255, 255],
];

export interface RevealSurface {
  /** The region's text colour, `#rrggbb`. */
  text: string;
  /** The region's own surface colour, laid over the backdrop at `1 - reveal`. */
  surface: string;
  /** Backdrop colours to hold against (sampled scene frames, a background's colours). */
  backdrops?: readonly Rgb[];
  minContrast?: number;
}

/**
 * The most a region may reveal and keep `text` readable over every backdrop: the largest
 * `reveal` in [0, 1] (to 1/100) for which `surface` at `1 - reveal` over each backdrop still
 * gives `minContrast`. 0 when even a solid surface fails, or a colour doesn't parse.
 */
export function revealCeiling(region: RevealSurface): number {
  const text = parseOpaqueColor(region.text);
  const surface = parseOpaqueColor(region.surface);
  if (!text || !surface) return 0;
  const backdrops = region.backdrops?.length ? region.backdrops : extremes;
  const floor = region.minContrast ?? revealMinContrast;
  const reads = (reveal: number) =>
    backdrops.every(
      (backdrop) => contrastRatio(text, over(surface, 1 - reveal, backdrop)) >= floor,
    );
  // Contrast falls as the reveal rises, so the last step that reads is the ceiling.
  let ceiling = 0;
  for (let step = 0; step <= 100; step++) {
    if (!reads(step / 100)) break;
    ceiling = step / 100;
  }
  return reads(0) ? ceiling : 0;
}

/**
 * The reveal a region draws with: the Suit's own value held under `ceiling` (`revealCeiling`),
 * or ace's default when the Suit doesn't set one. The default is ace's own look and isn't
 * clamped; a Suit's value can only be as visible as its text allows.
 */
export function clampReveal(
  manifest: Pick<SuitManifest, "reveal">,
  region: SuitRegion,
  ceiling: number,
): number {
  const wanted = manifest.reveal?.[region];
  if (wanted === undefined || !Number.isFinite(wanted)) return defaultSuitReveal[region];
  return Math.min(Math.max(wanted, 0), Math.max(0, Math.min(1, ceiling)));
}
