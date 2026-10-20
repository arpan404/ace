/*
 * How much of a viewer's full picture its link can carry at 60 fps (ADR 0088, amended). Pure,
 * with time passed in.
 *
 * Below a few hundredths of a bit per pixel per frame, a real-time encoder stops keeping its
 * frame rate: it skips frames to hold the bit rate. A thin link therefore gets a smaller
 * picture rather than fewer frames. The scale moves in fixed steps, and only once the link has
 * stayed short (or roomy, with spare) for a while, because every change is a new encode and a
 * keyframe.
 */

/** Bits per pixel per frame the encoder needs to keep every frame. */
export const keepFramesBpp = 0.02;
/** Each step is this much of the one above it, per side. */
const step = 0.84;
/** The smallest picture, per side. */
const steps = 6;
/** The link must carry a larger step's rate with this much spare before stepping up. */
const upSpare = 1.5;
/** ...for this long. */
const upAfterMs = 3_000;
/** The link must fall short of the current step this long before stepping down. */
const downAfterMs = 1_000;

export class PictureScale {
  #level = 0;
  #started = false;
  #upSince: number | undefined;
  #downSince: number | undefined;
  /** The picture's side scale for a link of `link` bits per second, `pixels` per frame at full size. */
  update(link: number, pixels: number, fps: number, now: number): number {
    const carries = (level: number, spare = 1) =>
      link >= pixels * scaleAt(level) ** 2 * fps * keepFramesBpp * spare;
    /** The largest picture the link carries (with `spare`), at most `steps` down. */
    const fitting = (spare = 1) => {
      let level = 0;
      while (level < steps && !carries(level, spare)) level++;
      return level;
    };
    // The first picture is sized for the link at once: a full-size first keyframe on a thin
    // link is seconds of backlog.
    if (!this.#started) {
      this.#started = true;
      this.#level = fitting();
      return scaleAt(this.#level);
    }
    if (this.#level < steps && !carries(this.#level)) {
      this.#upSince = undefined;
      this.#downSince ??= now;
      if (now - this.#downSince >= downAfterMs) {
        this.#level = fitting();
        this.#downSince = undefined;
      }
      return scaleAt(this.#level);
    }
    this.#downSince = undefined;
    // Up only after the link has carried a larger picture with spare for a while, and then
    // straight to the largest it carries: each change is a keyframe.
    const roomy = fitting(upSpare);
    if (roomy < this.#level) {
      this.#upSince ??= now;
      if (now - this.#upSince >= upAfterMs) {
        this.#level = roomy;
        this.#upSince = undefined;
      }
    } else this.#upSince = undefined;
    return scaleAt(this.#level);
  }
}

function scaleAt(level: number): number {
  return step ** level;
}
