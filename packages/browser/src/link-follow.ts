import type { ScreenStreamSettings } from "@ace/protocol";
import { linkFloor, type LinkRateLimits } from "./link-rate.ts";
import { PictureScale, type PictureStep } from "./video-scale.ts";

/**
 * Where a device or computer-use viewer's link estimate starts and stays: a phone on Wi-Fi or
 * 5G starts at 4 Mbit/s and climbs from there, a 3G one falls to the floor (or starts low on its
 * client's hint); the view's own request is the ceiling.
 */
export const pictureLinkLimits: LinkRateLimits = {
  min: linkFloor,
  max: 20_000_000,
  initial: 4_000_000,
};

/** What a viewer's link carries now (`LinkRate`). */
export interface FollowedLink {
  rate: number;
  probing: boolean;
}

/** A capped rate this close to the one applied isn't worth a change (or an encoder restart). */
const changeShare = 0.15;
/** Rates are rounded to this, so a steady link doesn't nudge the encoder every second... */
const rateStep = 250_000;
/** ...or to this below a megabit, where 250 kbit/s is most of the link. */
const thinRateStep = 50_000;
/** The smallest box a capture is asked for (`ScreenStreamSettings`). */
const smallestSide = 64;

const box = (side: number, scale: number) =>
  Math.min(side, Math.max(smallestSide, Math.ceil((side * scale) / 64) * 64));

/**
 * The view's stream held to what its link carries now: the bit rate capped to the link, and the
 * frame rate and size at the link's step (`video-scale.ts`), never above what the view asked.
 */
export function linkCapped(
  asked: ScreenStreamSettings,
  rate: number | undefined,
  step: PictureStep = { scale: 1, fps: asked.fps },
): ScreenStreamSettings {
  if (rate === undefined || asked.codec !== "h264") return asked;
  const unit = rate < 1_000_000 ? thinRateStep : rateStep;
  const carried = Math.max(linkFloor, Math.floor(rate / unit) * unit);
  return {
    ...asked,
    maxWidth: box(asked.maxWidth, step.scale),
    maxHeight: box(asked.maxHeight, step.scale),
    fps: Math.min(asked.fps, step.fps),
    bitrate: Math.min(asked.bitrate, carried),
  };
}

const sameStep = (a: ScreenStreamSettings, b: ScreenStreamSettings) =>
  a.fps === b.fps && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight;

/**
 * One viewer's stream request, kept within its link (ADR 0088's link-driven rate, ADR 0149's
 * steps, for device and computer-use views): the view asks for a size, rate and bit rate; what
 * reaches the capture is that request with the bit rate capped to what the viewer's link
 * carries, and on a thin link fewer frames first, then a smaller picture. `tick` (about once a
 * second) re-applies it when the step changed or the cap moved by more than 15 %.
 */
export class LinkFollow {
  readonly #apply: (settings: ScreenStreamSettings) => Promise<unknown>;
  readonly #link: () => FollowedLink | undefined;
  readonly #now: () => number;
  readonly #scale = new PictureScale();
  #asked: ScreenStreamSettings | undefined;
  #applied: ScreenStreamSettings | undefined;
  #closed = false;
  constructor(options: {
    apply(settings: ScreenStreamSettings): Promise<unknown>;
    link(): FollowedLink | undefined;
    now(): number;
  }) {
    this.#apply = options.apply;
    this.#link = options.link;
    this.#now = options.now;
  }
  /** The view's own request: applied at once, within the link. */
  ask(settings: ScreenStreamSettings): Promise<unknown> {
    this.#asked = settings;
    this.#applied = this.#capped(settings);
    return this.#apply(this.#applied);
  }
  /** Follow the link: re-apply the request when its step or cap moved enough to matter. */
  tick(): void {
    if (this.#closed || !this.#asked || !this.#applied) return;
    const next = this.#capped(this.#asked);
    const moved = Math.abs(next.bitrate - this.#applied.bitrate) / this.#applied.bitrate;
    if (moved <= changeShare && sameStep(next, this.#applied)) return;
    this.#applied = next;
    void this.#apply(next).catch(() => {});
  }
  close(): void {
    this.#closed = true;
  }
  #capped(asked: ScreenStreamSettings): ScreenStreamSettings {
    const link = this.#link();
    if (!link || asked.codec !== "h264") return asked;
    const step = this.#scale.update({
      link: link.rate,
      pixels: asked.maxWidth * asked.maxHeight,
      fps: asked.fps,
      now: this.#now(),
      probing: link.probing,
    });
    return linkCapped(asked, link.rate, step);
  }
}
