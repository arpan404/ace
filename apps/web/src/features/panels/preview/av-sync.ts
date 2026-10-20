/*
 * When to play each piece of the page's sound so it lines up with the video (ADR 0088, Audio).
 * Pure: times are passed in. Video and audio chunks are stamped on one daemon clock when they
 * were captured; this client's clock is another, so everything is kept as offsets: local time
 * minus stream time.
 *
 * Pictures show as soon as they decode. Sound can't: a chunk that arrives late leaves a gap, so
 * it is played a little behind its quickest arrival (a jitter buffer). The playout offset is the
 * later of that and the video's own offset, so sound waits for a picture that is running late,
 * but never more than `maxWaitMs` beyond its own buffer. The offset holds steady while the
 * target wanders a little, so consecutive chunks play back to back; a larger change, or a chunk
 * that would start in the past, starts a new schedule (one short gap).
 */

/** Sound plays this far behind its quickest recent arrival. */
export const bufferMs = 60;
/** A target this far from the schedule in use starts a new one. */
export const resyncMs = 60;
/** Sound waits at most this long (beyond its buffer) for pictures that run late. */
export const maxWaitMs = 500;

export class AvSync {
  private video: number | undefined;
  private arrival: number | undefined;
  private playout: number | undefined;
  /** A picture captured at `timestamp` (stream ms) showed at local time `shownAt` (ms). */
  shown(timestamp: number, shownAt: number): void {
    const offset = shownAt - timestamp;
    // Smoothed: one picture that decoded slowly doesn't move the sound.
    this.video = this.video === undefined ? offset : this.video + (offset - this.video) * 0.1;
  }
  /**
   * Sound captured at `timestamp` (stream ms), `duration` ms long, decoded at local time `now`:
   * the local time to start it, or undefined when it is over already (drop it).
   */
  schedule(timestamp: number, duration: number, now: number): number | undefined {
    const arrived = now - timestamp;
    // Rises at once with a late arrival; falls back slowly as arrivals speed up again.
    this.arrival =
      this.arrival === undefined
        ? arrived
        : Math.max(arrived, this.arrival + (arrived - this.arrival) * 0.02);
    const own = this.arrival + bufferMs;
    const target =
      this.video === undefined ? own : Math.max(own, Math.min(this.video, own + maxWaitMs));
    if (this.playout === undefined || Math.abs(target - this.playout) > resyncMs)
      this.playout = target;
    let at = timestamp + this.playout;
    if (at < now) {
      this.playout = target;
      at = timestamp + target;
    }
    return at + duration <= now ? undefined : Math.max(at, now);
  }
  /** The stream starts over (a new subscription, another tab): forget every offset. */
  reset(): void {
    this.video = undefined;
    this.arrival = undefined;
    this.playout = undefined;
  }
}
