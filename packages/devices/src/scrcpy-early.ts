import type { VideoUnit } from "./scrcpy-video.ts";

/** Most units held for a link not installed yet: about four seconds at 60 fps. */
const maxUnits = 240;
/** Most bytes held for it. */
const maxBytes = 16 * 1024 * 1024;

/**
 * D1: a scrcpy reader's units that arrive before the daemon installs its link. Ready and video
 * travel on separate lanes, so the reader's first keyframe can come before the link does; it
 * is held, with the deltas after it, and handed to the link once it is in. Bounded: past the
 * bound everything held is dropped and the link is told to ask for a keyframe.
 */
export class EarlyUnits {
  #units: VideoUnit[] = [];
  #bytes = 0;
  #lost = false;
  #closed = false;

  hold(unit: VideoUnit): void {
    // A reader that ended or failed admits nothing more: a unit already on the egress lane
    // must not refill the queue before teardown finishes.
    if (this.#closed) return;
    if (unit.keyframe) this.clear();
    else if (this.#units.length === 0) {
      // A delta with no keyframe held decodes to nothing.
      this.#lost = true;
      return;
    }
    if (this.#units.length >= maxUnits || this.#bytes + unit.payload.length > maxBytes) {
      this.clear();
      this.#lost = true;
      return;
    }
    this.#units.push(unit);
    this.#bytes += unit.payload.length;
  }

  /** What is held, in order, and whether units were dropped (the link then asks for a
   * keyframe). Nothing is held afterwards. */
  take(): { units: VideoUnit[]; lost: boolean } {
    const taken = { units: this.#units, lost: this.#lost };
    this.#units = [];
    this.#bytes = 0;
    this.#lost = false;
    return taken;
  }

  /** A new reader, or none: what an earlier one sent is never shown. A new dial is the one
   * place a closed queue opens again. */
  clear(): void {
    this.#units = [];
    this.#bytes = 0;
    this.#lost = false;
    this.#closed = false;
  }

  /** This reader ended or its handshake failed: what is held goes, and units still in
   * flight are dropped until a new dial calls `clear()`. */
  close(): void {
    this.clear();
    this.#closed = true;
  }
}
