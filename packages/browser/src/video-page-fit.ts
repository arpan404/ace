/**
 * Fits a page's CSS size into what a browser video header carries (100..4096 a side, what
 * every client takes), keeping the aspect: both sides scale by one factor. Returns the
 * fitted size with the scale multiplied by `factor` (CSS pixels per fitted pixel, 1 when it
 * fits), so the planned pixels (width x scale) stay the same, and the factor the person's
 * input scales back by.
 */
export function fitVideoPage(page: { width: number; height: number; scale: number }): {
  width: number;
  height: number;
  scale: number;
  factor: number;
} {
  const { width, height, scale } = page;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return { width: side(width), height: side(height), scale, factor: 1 };
  const larger = Math.max(width, height);
  const smaller = Math.min(width, height);
  const down = larger > 4096 ? 4096 / larger : smaller < 100 ? 100 / smaller : 1;
  const fitted = { width: side(width * down), height: side(height * down) };
  const factor = fitted.width > 0 ? width / fitted.width : 1;
  return { ...fitted, scale: scale * factor, factor };
}

/** One side of a page, as a video header carries it. */
function side(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(4096, Math.max(100, Math.round(value)));
}
