/*
 * How often a streaming message's open block may change on screen. Every update re-renders
 * the open block and can re-measure its row, so they come 10 to 20 times a second rather than
 * once a frame: often enough to read as live, calm enough to leave the frame to input.
 */

/** The fastest pace: 20 updates a second. */
export const fastestMs = 50;
/** The slowest: 10 a second, under load and when motion is reduced. */
export const slowestMs = 100;

/**
 * Milliseconds from one update of an open block to the next, given how long the last update
 * took from asking to answer: four times that, within 50–100 ms.
 */
export function updateInterval(lastMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return slowestMs;
  return Math.min(slowestMs, Math.max(fastestMs, lastMs * 4));
}
