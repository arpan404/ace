/*
 * When one encoder in ace's video extension encodes a captured frame, and whether as a keyframe
 * (ADR 0088). Pure, with the time passed in: the extension's offscreen document runs it per
 * frame, and tests drive it directly. No imports, so it bundles into the extension as is.
 */

/** A keyframe at least this often, so a viewer that lost its place is never stuck for long. */
export const keyframePeriodMs = 6_000;
/** Forced keyframes (a viewer joined or dropped deltas) at most this often per encode. */
export const keyframeGapMs = 500;
/** A still page sends no frames: an owed keyframe re-encodes the last one after this long. */
export const stillFrameMs = 100;
/** An encoder with frames in and nothing out for this long is stuck (ADR 0088's watchdog). */
export const stallMs = 1_500;

export type PaceDecision = "skip" | "delta" | "key";

export class EncodePacer {
  private fps: number;
  private nextAt = -Infinity;
  private lastKey = -Infinity;
  private owed = true;
  constructor(fps: number) {
    this.fps = fps;
  }
  /** A keyframe is owed; it goes with the next frame the gap allows. */
  requestKeyframe(): void {
    this.owed = true;
  }
  /** A captured frame arrived; `busy` is the encoder still working through earlier frames. */
  frame(now: number, busy: boolean): PaceDecision {
    if (busy) return "skip";
    if (this.keyDue(now)) return this.encoded(now, true);
    // Frames arrive on the display's clock with some jitter: one up to half a 60 Hz frame
    // before its slot still takes it, so 30 fps out of 60 Hz doesn't fall to every third frame.
    if (now < this.nextAt - 8) return "skip";
    return this.encoded(now, false);
  }
  /** No frame came for a while: whether to encode the last one again as an owed keyframe. */
  still(now: number, lastFrameAt: number, busy: boolean): boolean {
    if (busy || now - lastFrameAt < stillFrameMs || !this.keyDue(now)) return false;
    this.encoded(now, true);
    return true;
  }
  private keyDue(now: number): boolean {
    if (now - this.lastKey >= keyframePeriodMs) return true;
    return this.owed && now - this.lastKey >= keyframeGapMs;
  }
  private encoded(now: number, key: boolean): PaceDecision {
    const interval = 1000 / this.fps;
    // The next slot follows this one's; after a pause it starts again from now, not in a burst.
    this.nextAt = Math.max(this.nextAt + interval, now + interval - 8);
    if (!key) return "delta";
    this.lastKey = now;
    this.owed = false;
    return "key";
  }
}

/**
 * Tells a working encoder from one that takes frames and never answers (a hardware encoder that
 * accepted its config and then produced nothing, as branded Chrome 155 did headless).
 */
export class EncoderWatchdog {
  private waitingSince: number | undefined;
  submitted(now: number): void {
    this.waitingSince ??= now;
  }
  output(): void {
    this.waitingSince = undefined;
  }
  stalled(now: number): boolean {
    return this.waitingSince !== undefined && now - this.waitingSince >= stallMs;
  }
}
