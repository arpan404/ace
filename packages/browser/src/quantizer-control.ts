/*
 * The video extension's own rate control (ADR 0088, amended). Pure, no imports, so it bundles
 * into the extension as is.
 *
 * A hardware encoder told a bit rate holds it by skipping frames: Apple's H.264 at 1 Mbit/s
 * kept 16 of 60 frames of a scrolling page at 1280 × 800. In `quantizer` mode it encodes every
 * frame at the quantizer it is given, so ace picks one per frame from what recent frames cost:
 * frames that run large raise it, small ones lower it. The view keeps 60 fps; the link's limit
 * shows as coarser pictures. +6 on the quantizer roughly halves a frame.
 *
 * A still page sends no frames, so its last picture would keep whatever quantizer the motion
 * before it needed. Once it is still, the picture is encoded once more as a keyframe at a finer
 * quantizer (`settled`): unchanged blocks then reference that sharp picture until they change.
 * A keyframe, because a hardware encoder handed the same picture again may code it as "no
 * change" whatever the quantizer.
 */

/** H.264 and HEVC quantizers run 0–51; below this, a frame costs bits nobody sees. */
const lowest = 18;
const highest = 51;
/** Where an encode starts, before any frame has shown what the content costs. */
const initial = 36;
/** How much each frame moves the average of recent frame sizes. */
const smoothing = 0.25;
/** The quantizer moves at most this often (frames), letting the last change show first. */
const settleFrames = 3;
/**
 * A keyframe costs many deltas: it is coded coarser to keep its size in check, and the deltas
 * after it sharpen the picture again.
 */
const keyframeOffset = 6;
/**
 * A still page's sharper keyframe may cost about this many seconds of the bit rate, judged from
 * the last keyframe's size. Half a second of a thin link is a short wait; on this machine
 * (16 Mbit/s) it's room for near-lossless text.
 */
const settleSeconds = 0.5;

/**
 * Whether a still page's picture may be encoded again as a keyframe, for an encoder that picks
 * its own quantizer: the last keyframe, `keyBits` big, fits the budget at `bitrate`.
 */
export function affordsSettleKey(keyBits: number | undefined, bitrate: number): boolean {
  return keyBits !== undefined && keyBits <= bitrate * settleSeconds;
}

export class QuantizerControl {
  #quantizer = initial;
  #average: number | undefined;
  #sinceChange = 0;
  #bitsPerFrame: number;
  #bitrate: number;
  /** The quantizer the picture on screen was last encoded at. */
  #last = initial;
  /** The quantizer and size of the last keyframe: what a whole picture costs. */
  #keyQuantizer: number | undefined;
  #keyBits: number | undefined;
  constructor(bitrate: number, fps: number) {
    this.#bitsPerFrame = bitrate / fps;
    this.#bitrate = bitrate;
  }
  /** A new bit rate (the link changed): frames aim for it from now on. */
  retarget(bitrate: number, fps: number): void {
    this.#bitsPerFrame = bitrate / fps;
    this.#bitrate = bitrate;
  }
  /** The quantizer for the next frame. */
  next(key: boolean): number {
    const quantizer = Math.min(highest, this.#quantizer + (key ? keyframeOffset : 0));
    this.#last = quantizer;
    if (key) this.#keyQuantizer = quantizer;
    return quantizer;
  }
  /**
   * The quantizer to encode a still page's last picture again at, as a keyframe, as sharp as
   * the bit rate affords; undefined when that is no sharper than what is on screen.
   */
  settled(): number | undefined {
    if (this.#keyQuantizer === undefined || this.#keyBits === undefined) return undefined;
    const budget = this.#bitrate * settleSeconds;
    const quantizer = Math.max(
      lowest,
      Math.round(this.#keyQuantizer - 6 * Math.log2(budget / this.#keyBits)),
    );
    if (quantizer >= this.#last) return undefined;
    this.#last = quantizer;
    this.#keyQuantizer = quantizer;
    return quantizer;
  }
  /** A frame came out of the encoder at this many bytes. Keyframes don't steer the deltas. */
  observe(bytes: number, key: boolean): void {
    if (key) {
      this.#keyBits = bytes * 8;
      return;
    }
    const bits = bytes * 8;
    this.#average =
      this.#average === undefined ? bits : this.#average + (bits - this.#average) * smoothing;
    if (++this.#sinceChange < settleFrames) return;
    const ratio = this.#average / this.#bitsPerFrame;
    // Six steps halve a frame: move by the log of how far off the average is, damped.
    const step = Math.round(3 * Math.log2(ratio));
    if (step === 0) return;
    this.#quantizer = Math.min(
      highest,
      Math.max(lowest, this.#quantizer + Math.max(-2, Math.min(4, step))),
    );
    this.#sinceChange = 0;
  }
}
