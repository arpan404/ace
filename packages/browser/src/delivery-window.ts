/*
 * What a viewer's link delivered lately (`link-rate.ts`): bytes acknowledged over the last
 * second (the delivery rate) and the last two (a cut's longer look). Pure, with time passed in.
 *
 * Acks land in fixed buckets of `bucketMs`, each stamped with the newest ack's time in it, and
 * buckets older than the longer window leave before each add. So at most `cutWindowMs /
 * bucketMs` + 2 buckets ever live: `media-core` reserves that many, and no burst of acks grows
 * it. An ack's bytes stay at (within a bucket of) its own time: none is moved into an older
 * entry that would leave a window early.
 */

/** How long delivered bytes count for the delivery rate, and for a cut's longer look. */
export const deliveryWindowMs = 1_000;
export const cutWindowMs = 2_000;
/** Acks this close (one bucket) share an entry: 2 s over 128, exact in binary. */
export const bucketMs = cutWindowMs / 128;

interface Bucket {
  bucket: number;
  at: number;
  bytes: number;
}

export class DeliveryWindow {
  #buckets: Bucket[] = [];
  #recentBytes = 0;
  #longerBytes = 0;
  /** Index of the oldest bucket inside `deliveryWindowMs`. */
  #recent = 0;
  /** Bytes acknowledged at `at` (acks come in time order). */
  add(at: number, bytes: number): void {
    this.#prune(at);
    const bucket = Math.floor(at / bucketMs);
    const last = this.#buckets.at(-1);
    if (last && last.bucket === bucket) {
      last.at = at;
      // Within a bucket of `at`, which was just pruned for: inside the recent window.
      last.bytes += bytes;
    } else this.#buckets.push({ bucket, at, bytes });
    this.#recentBytes += bytes;
    this.#longerBytes += bytes;
  }
  /** Bits per second delivered over the last `deliveryWindowMs`, and over `cutWindowMs`. */
  rates(at: number): { recent: number; longer: number } {
    this.#prune(at);
    return {
      recent: (this.#recentBytes * 8 * 1000) / deliveryWindowMs,
      longer: (this.#longerBytes * 8 * 1000) / cutWindowMs,
    };
  }
  #prune(at: number): void {
    // Out of the recent window first, so nothing leaves the longer one still counted as recent.
    while (
      this.#recent < this.#buckets.length &&
      (this.#buckets[this.#recent]?.at ?? at) < at - deliveryWindowMs
    )
      this.#recentBytes -= this.#buckets[this.#recent++]?.bytes ?? 0;
    while (this.#recent > 0 && (this.#buckets[0]?.at ?? at) < at - cutWindowMs) {
      this.#longerBytes -= this.#buckets.shift()?.bytes ?? 0;
      this.#recent--;
    }
  }
}
