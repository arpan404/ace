/*
 * How much of a viewer's full picture its link can carry, and at what frame rate (ADR 0088,
 * amended by ADR 0149). Pure, with time passed in.
 *
 * Below a few hundredths of a bit per pixel per frame, a real-time encoder stops keeping its
 * frame rate on its own: it skips frames to hold the bit rate. So ace picks the frame rate and
 * the picture size itself, as one ladder of steps. Once the link has shown what it carries, a
 * thin link first loses frames down to 15 fps at full size; then the picture shrinks at 15 fps,
 * but no smaller than `readableSide` on its longer side, where text still reads; then 8 and
 * 5 fps; and only then is the picture shrunk further (the plan's 3G section refines ADR 0149's
 * "frame rate before size" this way: 15 fps of readable text beats 5 fps of a full one). While the rate is still probing up from its start, the low rate says
 * nothing about the link: the picture shrinks first and keeps every frame, as a fast link soon
 * shows. Every step also keeps a keyframe within half a second of the link: past that, the
 * picture is smaller rather than its keyframe mushy or late.
 *
 * Steps move only once the link has stayed short (or roomy, with spare) for a while, because
 * a new size is a new encode and a keyframe.
 */

/** Bits per pixel per frame the encoder needs to keep every frame at 60 fps. */
export const keepFramesBpp = 0.02;
/** The frame rates a picture steps through, before it shrinks. */
export const frameRates = [60, 30, 15, 8, 5] as const;
/** A keyframe of text costs about this many bits a pixel, at a quantizer that keeps it readable. */
export const keyframeBpp = 0.25;
/** A keyframe takes at most this long to send at the link's rate (ADR 0149 §3). */
export const keyframeSeconds = 0.5;
/** Each size step is this much of the one above it, per side. */
const sizeStep = 0.84;
/** The smallest picture, in size steps. */
const sizeSteps = 6;
/** Frame rates at or above this are kept at full size; below it the picture shrinks first. */
const steadyFps = 15;
/** At `steadyFps` the picture shrinks no smaller than this on its longer side, in pixels. */
export const readableSide = 1152;
/** The link must carry a larger step's rate with this much spare before stepping up... */
const upSpare = 1.5;
/** ...for this long. */
const upAfterMs = 3_000;
/**
 * A step up that only adds frames is no new encode and no keyframe (the frame rate changes in
 * place), so it needs less spare, for less long.
 */
const framesUpSpare = 1.2;
const framesUpAfterMs = 1_000;
/** The link must fall short of the current step this long before stepping down. */
const downAfterMs = 1_000;

/** A picture's side scale and frame rate. */
export interface PictureStep {
  scale: number;
  fps: number;
}

export interface PictureLink {
  /** Bits per second the link carries now. */
  link: number;
  /** Pixels per frame at full size. */
  pixels: number;
  /** The full picture's longer side, in pixels; without it, nothing shrinks at 15 fps. */
  side?: number;
  /** The highest frame rate the view asks for. */
  fps: number;
  now: number;
  /** The rate is still probing up from its start (`LinkRate.probing`). */
  probing?: boolean;
}

/**
 * Bits per pixel per frame at a lower frame rate: each frame carries more of the motion, so it
 * costs more, though less than in proportion.
 */
export function framesBpp(fps: number): number {
  return keepFramesBpp * Math.sqrt(60 / fps);
}

/** The bits per second a step needs: its frames, and its keyframe within `keyframeSeconds`. */
export function stepNeeds(pixels: number, step: PictureStep): number {
  const area = pixels * step.scale ** 2;
  return Math.max(area * step.fps * framesBpp(step.fps), (area * keyframeBpp) / keyframeSeconds);
}

/** Size steps at `steadyFps` that keep a picture of this longer side at least `readableSide`. */
export function readableSteps(side: number | undefined): number {
  let steps = 0;
  while (steps < sizeSteps && (side ?? 0) * sizeStep ** (steps + 1) >= readableSide) steps++;
  return steps;
}

/**
 * The steps from the full picture down. Measured: the frame rate to 15 fps at full size, then
 * the size at 15 fps down to `readable` steps, then 8 and 5 fps, then the size again. While
 * probing: the size first at the top frame rate, then the frame rate at the smallest size.
 */
export function pictureLadder(fps: number, probing: boolean, readable = 0): PictureStep[] {
  const rates = [fps, ...frameRates.filter((rate) => rate < fps)];
  const sizes = Array.from({ length: sizeSteps + 1 }, (_, level) => sizeStep ** level);
  const smallest = sizes.at(-1) ?? 1;
  if (probing)
    return [
      ...sizes.map((scale) => ({ scale, fps })),
      ...rates.slice(1).map((rate) => ({ scale: smallest, fps: rate })),
    ];
  const steady = rates.filter((rate) => rate >= steadyFps);
  const slow = rates.filter((rate) => rate < steadyFps);
  const shrinkAt = steady.at(-1);
  const kept = shrinkAt === undefined ? 0 : readable;
  const lowest = rates.at(-1) ?? fps;
  return [
    ...steady.map((rate) => ({ scale: 1, fps: rate })),
    ...sizes.slice(1, kept + 1).map((scale) => ({ scale, fps: shrinkAt ?? fps })),
    ...slow.map((rate) => ({ scale: sizes[kept] ?? 1, fps: rate })),
    ...sizes.slice(kept + 1).map((scale) => ({ scale, fps: lowest })),
  ];
}

export class PictureScale {
  #level = 0;
  #ladder: PictureStep[] | undefined;
  #key = "";
  #upSince: number | undefined;
  #downSince: number | undefined;
  /** The step for the link now. */
  update(input: PictureLink): PictureStep {
    const { link, pixels, now } = input;
    const probing = input.probing === true;
    const readable = readableSteps(input.side);
    const key = `${input.fps}/${probing}/${readable}`;
    const carries = (step: PictureStep, spare = 1) => link >= stepNeeds(pixels, step) * spare;
    const fitting = (ladder: PictureStep[], spare = 1) => {
      let level = 0;
      while (level < ladder.length - 1 && !carries(ladder[level] ?? { scale: 1, fps: 1 }, spare))
        level++;
      return level;
    };
    // The first picture is sized for the link at once: a full-size first keyframe on a thin
    // link is seconds of backlog. So is the first once the link has shown its limit.
    if (!this.#ladder || key !== this.#key) {
      this.#ladder = pictureLadder(input.fps, probing, readable);
      this.#key = key;
      this.#level = fitting(this.#ladder);
      this.#upSince = undefined;
      this.#downSince = undefined;
      return this.#step();
    }
    const ladder = this.#ladder;
    const last = ladder.length - 1;
    if (this.#level < last && !carries(this.#step())) {
      this.#upSince = undefined;
      this.#downSince ??= now;
      if (now - this.#downSince >= downAfterMs) {
        this.#level = fitting(ladder);
        this.#downSince = undefined;
      }
      return this.#step();
    }
    this.#downSince = undefined;
    // Up only after the link has carried a larger step with spare for a while, and then
    // straight to the largest it carries.
    const roomy = fitting(ladder, upSpare);
    // Short of a larger picture, the frames at this size may still step up.
    const scale = this.#step().scale;
    let frames = fitting(ladder, framesUpSpare);
    while (frames < this.#level && (ladder[frames]?.scale ?? scale) !== scale) frames++;
    const target = roomy < this.#level ? roomy : frames < this.#level ? frames : this.#level;
    if (target < this.#level) {
      const after = roomy < this.#level ? upAfterMs : framesUpAfterMs;
      this.#upSince ??= now;
      if (now - this.#upSince >= after) {
        this.#level = target;
        this.#upSince = undefined;
      }
    } else this.#upSince = undefined;
    return this.#step();
  }
  #step(): PictureStep {
    return this.#ladder?.[this.#level] ?? { scale: 1, fps: frameRates[0] };
  }
}
