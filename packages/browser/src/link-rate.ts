/*
 * How many bits per second one viewer's link carries right now (ADR 0088, amended by ADR 0149):
 * the video bit rate its encode should aim for. Pure, with time passed in.
 *
 * The signal is queueing delay: each chunk's round trip (sent → acknowledged), net of the time
 * the chunk itself takes to send at the current rate, against the lowest round trip seen lately.
 * While round trips stay near that floor, the rate climbs; when they stay above it, a queue is
 * building somewhere on the path and the rate falls to what was delivered. A dropped chunk cuts
 * it hard. The rate never climbs far above what the link has shown it can deliver, so a still
 * page (which sends almost nothing) doesn't hide a slow link. A new viewer starts low and climbs
 * fast until the link first shows a queue (a slow start), so a thin link never begins with
 * seconds of backlog.
 *
 * The links phones are on lose packets, and TCP hides a loss by stalling for a retransmit. A
 * stall is not a queue: a round trip that jumps a timeout above the smoothed one, out of a calm
 * link, reads as a loss, and it and the chunks held behind it say nothing about queueing. Only
 * queueing that lasts cuts the rate.
 */

export interface LinkRateLimits {
  /** Bits per second the rate never goes below or above. */
  min: number;
  max: number;
  /** Where a new viewer starts. */
  initial: number;
}

/**
 * What a client says about its link (ADR 0149 §4): `navigator.connection` and `Save-Data` on
 * the web, `NWPath` on iOS. It is the client's word: bounded, and it only lowers the start.
 */
export interface LinkHint {
  effectiveType?: string;
  downlinkKbps?: number;
  rttMs?: number;
  saveData?: boolean;
  expensive?: boolean;
  constrained?: boolean;
}

/** The lowest rate any link is driven at: a 3G link at its worst still carries this. */
export const linkFloor = 150_000;

/** How long the round-trip floor remembers its lowest sample. */
const floorWindowMs = 10_000;
/** How long delivered bytes are counted for the delivery rate. */
const deliveryWindowMs = 1_000;
/**
 * A cut aims at what was delivered over this longer window too, whichever is more: a loss
 * stall leaves a gap in the last second's deliveries that says nothing about the link.
 */
const cutWindowMs = 2_000;
/** The rate is reconsidered at most this often. */
const stepMs = 200;
/** Queueing delay above this lowers the rate; below `calmMs` it may rise. */
const queuedMs = 80;
const calmMs = 30;
/** Queueing must last this long before it cuts: one late ack is jitter, not a queue. */
const persistMs = 400;
/**
 * TCP's shortest retransmit timeout. A round trip this far above the smoothed one (or half a
 * floor: a fast retransmit costs a round trip) at once is a loss.
 */
const stallMs = 200;
/** A second stall this soon after one is a queue after all. */
const stallGapMs = 2_000;
const rise = 1.08;
/** Before the link has first shown a queue, the rate climbs this fast (a slow start). */
const startRise = 1.25;
/** A queue lowers the rate to this share of what was delivered, but never below `deepest`. */
const deliveredShare = 0.9;
const deepest = 0.6;
const dropFall = 0.6;
/** How far above the best rate it has delivered lately the rate may aim. */
const headroom = 1.3;
/** A delivered rate is remembered this long as proof of what the link carries. */
const provenWindowMs = 30_000;
/** Bytes in flight may hold the link's rate for its round trip plus this long, no more. */
export const backlogMs = 300;

/**
 * Sends awaiting an ack that are remembered; past this the oldest is forgotten. A viewer's
 * window holds 60, and even an unwindowed sender on a link that just slowed stays near 300, so
 * this only bounds memory when acks stop coming.
 */
export const outstandingSends = 512;

/** Where a viewer's rate starts, given what its client says about the link: never higher. */
export function hintedStart(limits: LinkRateLimits, hint: LinkHint | undefined): number {
  let start = limits.initial;
  if (hint) {
    const kbps = hint.downlinkKbps;
    // The client's estimate is of the whole link, and coarse: half of it for video.
    if (kbps !== undefined && Number.isFinite(kbps) && kbps > 0)
      start = Math.min(start, kbps * 500);
    const type = hint.effectiveType;
    if (type === "slow-2g" || type === "2g") start = limits.min;
    else if (type === "3g") start = Math.min(start, 400_000);
    const rtt = hint.rttMs;
    if (rtt !== undefined && Number.isFinite(rtt) && rtt >= 400) start = Math.min(start, 400_000);
    if (hint.saveData === true || hint.constrained === true) start = Math.min(start, 300_000);
    if (hint.expensive === true) start = Math.min(start, 1_000_000);
  }
  return Math.round(Math.min(limits.initial, Math.max(limits.min, start)));
}

interface Sent {
  sequence: number;
  bytes: number;
  at: number;
}

export class LinkRate {
  readonly #limits: LinkRateLimits;
  /** Where it started: the rate climbs this far before the link has proven anything. */
  readonly #start: number;
  #rate: number;
  #inflight: Sent[] = [];
  /** Smoothed round trips, ascending by time and by value (a monotonic queue for the floor). */
  #floor: { at: number; rtt: number }[] = [];
  #smoothed: number | undefined;
  #delivered: { at: number; bytes: number }[] = [];
  /** Bytes delivered over `cutWindowMs`, and the share of them inside `deliveryWindowMs`. */
  #cutBytes = 0;
  #deliveredBytes = 0;
  /** Index of the oldest entry inside `deliveryWindowMs`. */
  #recent = 0;
  #proven: { at: number; rate: number }[] = [];
  #lastStep = -Infinity;
  /** The rate rises at most once a round trip: what a rise did shows a round trip later. */
  #lastRise = -Infinity;
  /** After a cut, the queue it found needs a round trip to drain before it says anything new. */
  #holdUntil = -Infinity;
  /** After a drop's cut, later drops come from the backlog it is still draining. */
  #dropHoldUntil = -Infinity;
  #dropped = false;
  /** No queue or drop seen yet: still finding what the link carries. */
  #starting = true;
  /** The client's hint lowered the start: the link is known to be thin. */
  readonly #hinted: boolean;
  /** Since when queueing has stayed above `queuedMs`. */
  #queuedSince: number | undefined;
  /**
   * Chunks sent before `sentBefore` were held behind a stall: until `until` (the stall's length
   * after it showed) their round trips are not queueing.
   */
  #stall = { sentBefore: -Infinity, until: -Infinity };
  #lastStall = -Infinity;
  constructor(limits: LinkRateLimits, hint?: LinkHint) {
    this.#limits = limits;
    this.#start = hintedStart(limits, hint);
    this.#rate = this.#start;
    this.#hinted = this.#start < limits.initial;
  }
  /** The bit rate the viewer's encode should aim for. */
  get rate(): number {
    return this.#rate;
  }
  /** The smoothed round trip, once one is known. */
  get rtt(): number | undefined {
    return this.#smoothed;
  }
  /**
   * Still probing upward from a guessed start: the rate says what has been tried, not what the
   * link carries. A start the client's hint lowered is not a guess.
   */
  get probing(): boolean {
    return this.#starting && !this.#hinted;
  }
  /**
   * The most bytes a viewer should have in flight: the rate for a round trip plus `backlogMs`.
   * Unbounded until a round trip is known.
   */
  get backlogBytes(): number | undefined {
    if (this.#smoothed === undefined) return undefined;
    return Math.round((this.#rate / 8) * ((this.#smoothed + backlogMs) / 1000));
  }
  sent(sequence: number, bytes: number, at: number): void {
    if (this.#inflight.length >= outstandingSends) this.#inflight.shift();
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
      this.#cutBytes += chunk.bytes;
    }
    if (!newest) return;
    this.#inflight.splice(0, count);
    // The chunk's own time on the wire is not queueing: a keyframe on a thin link takes long.
    const own = (newest.bytes * 8000) / this.#rate;
    this.#sample(Math.max(0, at - newest.at - own), newest.at, at);
    this.#step(at);
  }
  /**
   * A chunk didn't fit the viewer's window and was dropped. One cut a round trip: drops right
   * after one come from the backlog it is still draining.
   */
  dropped(at: number): void {
    // Drops while a stall holds the link, or right after a cut, say nothing new.
    if (at < this.#dropHoldUntil || at <= this.#stall.until) return;
    // The window filled because the link stalled on a loss, not because it is too slow.
    const oldest = this.#inflight[0];
    if (oldest && this.#stalls(at - oldest.at, at, false)) {
      this.#stalled(at, Math.max(stallMs, this.#floor[0]?.rtt ?? 0));
      return;
    }
    this.#dropped = true;
    this.#step(at, true);
    this.#dropHoldUntil = at + (this.#smoothed ?? 0) + stepMs;
  }
  /** Chunks sent before a new encode don't count against the new one. */
  reset(): void {
    this.#inflight = [];
  }
  /**
   * Whether a round trip this long, now, is a retransmit stall: a jump above the smoothed round
   * trip that no queue makes in one chunk. A queue grows a chunk's send time at a time; `calm`
   * also asks that none was building (an ack's sample, not a drop's age).
   */
  #stalls(rtt: number, at: number, calm: boolean): boolean {
    const floor = this.#floor[0]?.rtt;
    const smoothed = this.#smoothed;
    if (floor === undefined || smoothed === undefined) return false;
    return (
      rtt - smoothed >= Math.max(stallMs, floor / 2) &&
      (!calm || smoothed - floor < queuedMs) &&
      at - this.#lastStall >= stallGapMs
    );
  }
  #stalled(at: number, length: number): void {
    this.#lastStall = at;
    this.#stall = { sentBefore: at, until: at + length };
    // Nothing is learned while the chunks behind it come in.
    this.#holdUntil = Math.max(this.#holdUntil, at + length);
  }
  #sample(rtt: number, sentAt: number, at: number): void {
    if (sentAt < this.#stall.sentBefore && at <= this.#stall.until) return;
    if (this.#stalls(rtt, at, true)) return this.#stalled(at, rtt - (this.#smoothed ?? 0));
    const value = this.#smoothed === undefined ? rtt : this.#smoothed * 0.875 + rtt * 0.125;
    this.#smoothed = value;
    while (this.#floor.length && (this.#floor.at(-1)?.rtt ?? 0) >= value) this.#floor.pop();
    this.#floor.push({ at, rtt: value });
    while (this.#floor.length > 1 && (this.#floor[0]?.at ?? at) < at - floorWindowMs)
      this.#floor.shift();
  }
  /** Bits per second delivered over the last `deliveryWindowMs`, and over `cutWindowMs`. */
  #deliveryRate(at: number): { recent: number; longer: number } {
    // Out of the recent window first, so nothing leaves the longer one still counted as recent.
    while (
      this.#recent < this.#delivered.length &&
      (this.#delivered[this.#recent]?.at ?? at) < at - deliveryWindowMs
    )
      this.#deliveredBytes -= this.#delivered[this.#recent++]?.bytes ?? 0;
    while (this.#recent > 0 && (this.#delivered[0]?.at ?? at) < at - cutWindowMs) {
      this.#cutBytes -= this.#delivered.shift()?.bytes ?? 0;
      this.#recent--;
    }
    return {
      recent: (this.#deliveredBytes * 8 * 1000) / deliveryWindowMs,
      longer: (this.#cutBytes * 8 * 1000) / cutWindowMs,
    };
  }
  #provenRate(at: number, delivered: number): number {
    while (this.#proven.length && (this.#proven[0]?.at ?? at) < at - provenWindowMs)
      this.#proven.shift();
    while (this.#proven.length && (this.#proven.at(-1)?.rate ?? 0) <= delivered) this.#proven.pop();
    this.#proven.push({ at, rate: delivered });
    return this.#proven[0]?.rate ?? delivered;
  }
  #step(at: number, now = false): void {
    if (!now && at - this.#lastStep < stepMs) return;
    this.#lastStep = at;
    const { min, max } = this.#limits;
    const rates = this.#deliveryRate(at);
    const delivered = rates.recent;
    const floor = this.#floor[0]?.rtt ?? 0;
    const queueing = (this.#smoothed ?? floor) - floor;
    const proven = this.#provenRate(at, delivered);
    if (queueing > queuedMs) this.#queuedSince ??= at;
    else this.#queuedSince = undefined;
    let rate = this.#rate;
    const cut = (to: number) => {
      this.#starting = false;
      rate = Math.max(rate * deepest, Math.min(rate, to));
      this.#holdUntil = at + (this.#smoothed ?? 0) + stepMs;
      this.#queuedSince = undefined;
    };
    if (this.#dropped) cut(Math.min(rate, delivered || rate) * dropFall);
    else if (this.#queuedSince !== undefined) {
      if (at >= this.#holdUntil && at - this.#queuedSince >= persistMs)
        cut(Math.max(delivered, rates.longer) * deliveredShare);
    } else if (
      queueing < calmMs &&
      at >= this.#holdUntil &&
      at - this.#lastRise >= (this.#smoothed ?? 0)
    ) {
      this.#lastRise = at;
      rate = Math.max(
        rate,
        Math.min(
          rate * (this.#starting ? startRise : rise),
          Math.max(this.#start, proven * headroom),
        ),
      );
    }
    this.#dropped = false;
    this.#rate = Math.round(Math.min(max, Math.max(min, rate)));
  }
}
