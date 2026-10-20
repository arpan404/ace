/*
 * How many bits per second one viewer's link carries right now (ADR 0088, amended): the video
 * bit rate its encode should aim for. Pure, with time passed in.
 *
 * A live view keeps its frame rate and spends what the link can carry on picture quality. The
 * signal is queueing delay: each chunk's round trip (sent → acknowledged) against the lowest
 * round trip seen lately. While round trips stay near that floor, the rate climbs; when they
 * grow, a queue is building somewhere on the path and the rate falls to what was delivered.
 * A dropped chunk cuts it hard. The rate never climbs far above what the link has shown it
 * can deliver, so a still page (which sends almost nothing) doesn't hide a slow link.
 */

export interface LinkRateLimits {
  /** Bits per second the rate never goes below or above. */
  min: number;
  max: number;
  /** Where a new viewer starts. */
  initial: number;
}

/** How long the round-trip floor remembers its lowest sample. */
const floorWindowMs = 10_000;
/** How long delivered bytes are counted for the delivery rate. */
const deliveryWindowMs = 1_000;
/** The rate is reconsidered at most this often. */
const stepMs = 200;
/** Queueing delay above this lowers the rate; below `calmMs` it may rise. */
const queuedMs = 80;
const calmMs = 30;
const rise = 1.08;
/** A queue lowers the rate to this share of what was delivered, but never below `deepest`. */
const deliveredShare = 0.9;
const deepest = 0.6;
const dropFall = 0.6;
/** How far above the best rate it has delivered lately the rate may aim. */
const headroom = 1.3;
/** A delivered rate is remembered this long as proof of what the link carries. */
const provenWindowMs = 30_000;

interface Sent {
  sequence: number;
  bytes: number;
  at: number;
}

export class LinkRate {
  readonly #limits: LinkRateLimits;
  #rate: number;
  #inflight: Sent[] = [];
  /** Smoothed round trips, ascending by time and by value (a monotonic queue for the floor). */
  #floor: { at: number; rtt: number }[] = [];
  #smoothed: number | undefined;
  #delivered: { at: number; bytes: number }[] = [];
  #deliveredBytes = 0;
  #proven: { at: number; rate: number }[] = [];
  #lastStep = -Infinity;
  /** After a cut, the queue it found needs a round trip to drain before it says anything new. */
  #holdUntil = -Infinity;
  #dropped = false;
  constructor(limits: LinkRateLimits) {
    this.#limits = limits;
    this.#rate = limits.initial;
  }
  /** The bit rate the viewer's encode should aim for. */
  get rate(): number {
    return this.#rate;
  }
  /** The smoothed round trip, once one is known. */
  get rtt(): number | undefined {
    return this.#smoothed;
  }
  sent(sequence: number, bytes: number, at: number): void {
    this.#inflight.push({ sequence, bytes, at });
  }
  /** The viewer showed every chunk up to `sequence` (acks are cumulative). */
  acknowledged(sequence: number, at: number): void {
    let newest: Sent | undefined;
    let count = 0;
    for (const chunk of this.#inflight) {
      if (chunk.sequence > sequence) break;
      newest = chunk;
      count++;
      this.#delivered.push({ at, bytes: chunk.bytes });
      this.#deliveredBytes += chunk.bytes;
    }
    if (!newest) return;
    this.#inflight.splice(0, count);
    this.#sample(at - newest.at, at);
    this.#step(at);
  }
  /** A chunk didn't fit the viewer's window and was dropped. */
  dropped(at: number): void {
    this.#dropped = true;
    this.#step(at);
  }
  /** Chunks sent before a new encode don't count against the new one. */
  reset(): void {
    this.#inflight = [];
  }
  #sample(rtt: number, at: number): void {
    const sample = Math.max(0, rtt);
    const value = this.#smoothed === undefined ? sample : this.#smoothed * 0.875 + sample * 0.125;
    this.#smoothed = value;
    while (this.#floor.length && (this.#floor.at(-1)?.rtt ?? 0) >= value) this.#floor.pop();
    this.#floor.push({ at, rtt: value });
    while (this.#floor.length > 1 && (this.#floor[0]?.at ?? at) < at - floorWindowMs)
      this.#floor.shift();
  }
  #deliveryRate(at: number): number {
    while (this.#delivered.length && (this.#delivered[0]?.at ?? at) < at - deliveryWindowMs)
      this.#deliveredBytes -= this.#delivered.shift()?.bytes ?? 0;
    return (this.#deliveredBytes * 8 * 1000) / deliveryWindowMs;
  }
  #provenRate(at: number, delivered: number): number {
    while (this.#proven.length && (this.#proven[0]?.at ?? at) < at - provenWindowMs)
      this.#proven.shift();
    while (this.#proven.length && (this.#proven.at(-1)?.rate ?? 0) <= delivered) this.#proven.pop();
    this.#proven.push({ at, rate: delivered });
    return this.#proven[0]?.rate ?? delivered;
  }
  #step(at: number): void {
    if (at - this.#lastStep < stepMs) return;
    this.#lastStep = at;
    const { min, max } = this.#limits;
    const delivered = this.#deliveryRate(at);
    const floor = this.#floor[0]?.rtt ?? 0;
    const queueing = (this.#smoothed ?? floor) - floor;
    const proven = this.#provenRate(at, delivered);
    let rate = this.#rate;
    const cut = (to: number) => {
      rate = Math.max(rate * deepest, Math.min(rate, to));
      this.#holdUntil = at + (this.#smoothed ?? 0) + stepMs;
    };
    if (this.#dropped) cut(Math.min(rate, delivered || rate) * dropFall);
    else if (queueing > queuedMs) {
      if (at >= this.#holdUntil) cut(delivered * deliveredShare);
    } else if (queueing < calmMs && at >= this.#holdUntil)
      rate = Math.max(
        rate,
        Math.min(rate * rise, Math.max(this.#limits.initial, proven * headroom)),
      );
    this.#dropped = false;
    this.#rate = Math.round(Math.min(max, Math.max(min, rate)));
  }
}
