import type { ScreenStreamSettings } from "@ace/protocol";
import type { LinkRateLimits } from "./link-rate.ts";

/**
 * Where a device or computer-use viewer's link estimate starts and stays: a phone on Wi-Fi or
 * 5G starts at 4 Mbit/s and climbs from there; the view's own request is the ceiling.
 */
export const pictureLinkLimits: LinkRateLimits = {
  min: 750_000,
  max: 20_000_000,
  initial: 4_000_000,
};

/** A capped rate this close to the one applied isn't worth a change (or an encoder restart). */
const changeShare = 0.15;
/** Rates are rounded to this, so a steady link doesn't nudge the encoder every second. */
const rateStep = 250_000;

/** The view's stream with its bit rate held to what its link carries now. */
export function linkCapped(
  asked: ScreenStreamSettings,
  rate: number | undefined,
): ScreenStreamSettings {
  if (rate === undefined || asked.codec !== "h264") return asked;
  const carried = Math.max(rateStep, Math.floor(rate / rateStep) * rateStep);
  return { ...asked, bitrate: Math.max(128_000, Math.min(asked.bitrate, carried)) };
}

/**
 * One viewer's stream request, kept within its link (ADR 0088's link-driven rate, for device
 * and computer-use views): the view asks for a size, rate and bit rate; what reaches the
 * capture is that request with the bit rate capped to what the viewer's link carries. `tick`
 * (about once a second) re-applies it when the cap has moved by more than 15 %.
 */
export class LinkFollow {
  readonly #apply: (settings: ScreenStreamSettings) => Promise<unknown>;
  readonly #rate: () => number | undefined;
  #asked: ScreenStreamSettings | undefined;
  #applied: ScreenStreamSettings | undefined;
  #closed = false;
  constructor(options: {
    apply(settings: ScreenStreamSettings): Promise<unknown>;
    rate(): number | undefined;
  }) {
    this.#apply = options.apply;
    this.#rate = options.rate;
  }
  /** The view's own request: applied at once, within the link. */
  ask(settings: ScreenStreamSettings): Promise<unknown> {
    this.#asked = settings;
    this.#applied = linkCapped(settings, this.#rate());
    return this.#apply(this.#applied);
  }
  /** Follow the link: re-apply the request when its cap moved enough to matter. */
  tick(): void {
    if (this.#closed || !this.#asked || !this.#applied) return;
    const next = linkCapped(this.#asked, this.#rate());
    const moved = Math.abs(next.bitrate - this.#applied.bitrate) / this.#applied.bitrate;
    if (moved <= changeShare) return;
    this.#applied = next;
    void this.#apply(next).catch(() => {});
  }
  close(): void {
    this.#closed = true;
  }
}
