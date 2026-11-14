import type { MediaLinkHint } from "@ace/protocol";

/*
 * Where a remote viewer's video starts, from what its client says about its link (ADR 0149,
 * K3). Pure. The hint is the client's word, so it can only start a viewer lower than it would
 * start anyway, never higher; and it is read once, when the viewer's link is new, so it never
 * moves a rate the link has since measured (`link-rate.ts` owns that).
 */

/** A link the client calls slow, or one the person wants to spare, starts at the floor. */
const slowTypes = new Set(["slow-2g", "2g"]);
/** A 3G link or a long round trip starts no higher than this. */
const thinStart = 500_000;
const longRttMs = 300;
/** A metered link (cellular, a hotspot) starts no higher than this. */
const meteredStart = 1_000_000;
/** Video takes at most this share of the downlink the client estimates. */
const downlinkShare = 0.5;

/** The starting bit rate: `ceiling` without a hint, never above it, never below `floor`. */
export function hintedStart(
  hint: MediaLinkHint | undefined,
  ceiling: number,
  floor: number,
): number {
  if (!hint) return ceiling;
  if (hint.saveData || hint.constrained) return floor;
  if (hint.effectiveType && slowTypes.has(hint.effectiveType)) return floor;
  let start = ceiling;
  if (hint.effectiveType === "3g") start = Math.min(start, thinStart);
  if (hint.rttMs !== undefined && hint.rttMs >= longRttMs) start = Math.min(start, thinStart);
  if (hint.expensive) start = Math.min(start, meteredStart);
  if (hint.downlinkKbps !== undefined)
    start = Math.min(start, hint.downlinkKbps * 1_000 * downlinkShare);
  return Math.max(floor, Math.min(ceiling, start));
}
