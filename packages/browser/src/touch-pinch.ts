import type { BrowserInput } from "@ace/protocol";

type TouchInput = Extract<BrowserInput, { kind: "touch" }>;

/** Changes of the fingers' spread smaller than this wait for the next move. */
const threshold = 0.02;

/**
 * Chromium hands injected two-finger touches to the page but never turns them into a pinch, so
 * the page would not zoom. This follows the spread of the first two fingers through a touch
 * sequence and says how far the page should be zoomed from where the pinch began. Pure: one
 * per tab; the caller keeps the page's scale at the pinch's start in `base`.
 */
export class TouchPinch {
  /** The page's scale when the current pinch began, once the caller has read it. */
  base: number | undefined;
  private pair: string | undefined;
  private start: number | undefined;
  private last = 1;

  /** The zoom from the pinch's start this touch asks for, when it changed enough to apply. */
  next(input: TouchInput): number | undefined {
    const [first, second] = input.points;
    if (input.event === "touchEnd" || input.event === "touchCancel" || !first || !second) {
      this.reset();
      return undefined;
    }
    const pair = `${first.id}:${second.id}`;
    const spread = Math.hypot(second.x - first.x, second.y - first.y);
    if (pair !== this.pair || this.start === undefined || this.start <= 0) {
      this.reset();
      this.pair = pair;
      this.start = spread;
      return undefined;
    }
    const zoom = spread / this.start;
    if (Math.abs(zoom / this.last - 1) < threshold) return undefined;
    this.last = zoom;
    return zoom;
  }

  private reset(): void {
    this.base = undefined;
    this.pair = undefined;
    this.start = undefined;
    this.last = 1;
  }
}
