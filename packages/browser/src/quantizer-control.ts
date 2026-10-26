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

/** A codec's quantizer domain and measured response to frame size. */
interface QuantizerProfile {
  min: number;
  max: number;
  initial: number;
  keyframeOffset: number;
  stepsPerDoubling: number;
}

const avcProfile: QuantizerProfile = {
  min: 18,
  max: 51,
  initial: 36,
  keyframeOffset: 6,
  stepsPerDoubling: 6,
};

/**
 * VP9 uses 0–255 indices. A 1318×1650 text-page probe produced 176 KB at
 * index 96 and 85 KB at 192, so 96 steps approximate a doubling of cost.
 * Quality gains flattened below index 32 on that probe. The same half-second
 * still-frame budget applies; observed frame sizes keep steering motion.
 */
const vp9Profile: QuantizerProfile = {
  min: 32,
  max: 255,
  initial: 128,
  keyframeOffset: 24,
  stepsPerDoubling: 96,
};
/** How much each frame moves the average of recent frame sizes. */
const smoothing = 0.25;
/** The quantizer moves at most this often (frames), letting the last change show first. */
const settleFrames = 3;
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
  #profile: QuantizerProfile = avcProfile;
  #quantizer: number;
  #average: number | undefined;
  #sinceChange = 0;
  #bitsPerFrame: number;
  #bitrate: number;
  /** The quantizer the picture on screen was last encoded at. */
  #last: number;
  /** The quantizer and size of the last keyframe: what a whole picture costs. */
  #keyQuantizer: number | undefined;
  #keyBits: number | undefined;
  constructor(bitrate: number, fps: number) {
    this.#bitsPerFrame = bitrate / fps;
    this.#bitrate = bitrate;
    this.#quantizer = this.#profile.initial;
    this.#last = this.#profile.initial;
  }
  /** VP9 profile from the owned Chrome probe: 32–255, start 128. */
  static vp9(bitrate: number, fps: number): QuantizerControl {
    const control = new QuantizerControl(bitrate, fps);
    control.#profile = vp9Profile;
    control.#quantizer = vp9Profile.initial;
    control.#last = vp9Profile.initial;
    return control;
  }
  /** A new bit rate (the link changed): frames aim for it from now on. */
  retarget(bitrate: number, fps: number): void {
    this.#bitsPerFrame = bitrate / fps;
    this.#bitrate = bitrate;
  }
  /** The quantizer for the next frame. */
  next(key: boolean): number {
    const quantizer = Math.min(
      this.#profile.max,
      this.#quantizer + (key ? this.#profile.keyframeOffset : 0),
    );
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
      this.#profile.min,
      Math.round(
        this.#keyQuantizer - this.#profile.stepsPerDoubling * Math.log2(budget / this.#keyBits),
      ),
    );
    if (quantizer >= this.#last) return undefined;
    this.#last = quantizer;
    // Its size is known once it comes out; until then there is nothing to judge another by.
    this.#keyQuantizer = quantizer;
    this.#keyBits = undefined;
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
    // Move by the log of how far off the average is, damped: half the
    // doubling steps per change, clamped to +2/3 / -1/3 of a doubling.
    const step = Math.round((this.#profile.stepsPerDoubling / 2) * Math.log2(ratio));
    if (step === 0) return;
    const up = (this.#profile.stepsPerDoubling * 2) / 3;
    const down = this.#profile.stepsPerDoubling / 3;
    this.#quantizer = Math.min(
      this.#profile.max,
      Math.max(this.#profile.min, this.#quantizer + Math.max(-down, Math.min(up, step))),
    );
    this.#sinceChange = 0;
  }
}
