/**
 * The rail's dock-like magnification: the tick under the pointer grows most and its neighbours
 * less, falling off smoothly to the resting size a few ticks away on either side.
 * Pure: the caller passes where the pointer and the ticks are, and draws the scales it gets back.
 */

/** How much longer the tick right under the pointer draws than a resting one. */
export const magnifyPeak = 1.6;
/** How many neighbours on each side the growth reaches across, at the rail's spacing. */
export const magnifyNeighbours = 4;
/** The reach never shrinks below this, in pixels, so a crowded rail still swells visibly. */
export const magnifyMinReach = 24;

/**
 * A scale for each tick, 1 for resting: `pointer` and `ticks` are vertical positions on the rail,
 * in pixels, and `spacing` the distance between neighbouring ticks. With no pointer, all rest.
 */
export function magnifyScales(
  pointer: number | undefined,
  ticks: readonly number[],
  spacing: number,
): number[] {
  if (pointer === undefined) return ticks.map(() => 1);
  const reach = Math.max(magnifyMinReach, magnifyNeighbours * spacing);
  return ticks.map((tick) => {
    const distance = Math.abs(tick - pointer);
    if (distance >= reach) return 1;
    // A raised cosine: full growth at the pointer, easing to nothing at the reach with no kink.
    const weight = (1 + Math.cos((Math.PI * distance) / reach)) / 2;
    return 1 + (magnifyPeak - 1) * weight;
  });
}
