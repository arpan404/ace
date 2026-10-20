/*
 * When captured sound was heard, on the clock the video's timestamps use (ADR 0088, Audio). The
 * extension's offscreen document stamps video frames with `performance.now()`; audio samples
 * carry the capture's own media timestamps, whose origin is the browser's business. This maps
 * one onto the other. Pure, with the time passed in, and no imports, so it bundles into the
 * extension as is.
 */

/** A media timestamp this far from where the mapping puts it starts a new mapping. */
export const reanchorMs = 200;

export class MediaClock {
  private offset: number | undefined;
  /**
   * A sample stamped `timestamp` (µs, media clock) arrived at `now` (ms): when it was captured,
   * in ms on `now`'s clock. Samples are never captured after they arrive, so the mapping follows
   * the quickest arrival; a jump in either clock starts a new mapping.
   */
  arrived(timestamp: number, now: number): number {
    const media = timestamp / 1000;
    const mapped = this.offset === undefined ? undefined : media + this.offset;
    if (mapped === undefined || mapped > now || now - mapped > reanchorMs)
      this.offset = now - media;
    return media + (this.offset ?? 0);
  }
  /** A media timestamp (µs) on `now`'s clock, as the last arrival mapped it. */
  map(timestamp: number): number | undefined {
    return this.offset === undefined ? undefined : timestamp / 1000 + this.offset;
  }
}
