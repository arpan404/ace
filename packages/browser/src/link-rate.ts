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

import type { MediaLinkHint } from "@ace/protocol";
import { DeliveryWindow } from "./delivery-window.ts";
import { hintedStart } from "./link-start.ts";

export interface LinkRateLimits {
  /** Bits per second the rate never goes below or above. */
  min: number;
  max: number;
  /** Where a new viewer starts. */
  initial: number;
}

/** The lowest rate any link is driven at: a 3G link at its worst still carries this. */
export const linkFloor = 150_000;

/** How long the round-trip floor remembers its lowest sample. */
const floorWindowMs = 10_000;
/** The rate is reconsidered at most this often. */
const stepMs = 200;
/** Queueing delay above this lowers the rate; below `calmMs` it may rise. */
const queuedMs = 80;
const calmMs = 30;
/** ...or this share of the floor, whichever is more. */
const calmShare = 0.1;
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
/** A drain holds the rate to this share of what is delivered, for twice the queueing... */
const drainShare = 0.5;
/** ...and a link calm this many round trips is probed upward faster again, at `probeRise`. */
const calmRtts = 3;
const probeRise = 1.1;
/** Before the link has first shown a queue, the rate climbs this fast (a slow start). */
const startRise = 1.25;
/** A queue lowers the rate to this share of what was delivered, but never below `deepest`. */
const deliveredShare = 0.9;
/** The link carried the rate when it delivered at least this share of it. */
const carriedShare = 0.95;
const deepest = 0.6;
/** A drop with nothing delivered to judge by cuts to this share: CUBIC's beta. */
const dropFall = 0.7;
/** How far above the best rate it has delivered lately the rate may aim. */
const headroom = 1.3;
/** A delivered rate is remembered this long as proof of what the link carries. */
const provenWindowMs = 30_000;
/** Bytes in flight may hold the link's rate for its round trip plus at least this long. */
export const backlogMs = 300;

/**
 * Sends awaiting an ack that are remembered; past this the oldest is forgotten. A viewer's
 * window holds 60, and even an unwindowed sender on a link that just slowed stays near 300, so
 * this only bounds memory when acks stop coming.
 */
export const outstandingSends = 512;

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
  /** What the link delivered over the last second, and the last two. */
  readonly #delivered = new DeliveryWindow();
  #proven: { at: number; rate: number }[] = [];
  #lastStep = -Infinity;
  /** The rate rises at most once a path round trip: what a rise did shows a round trip later. */
  #lastRise = -Infinity;
  /** After a cut, the queue it found needs a round trip to drain before it says anything new. */
  #holdUntil = -Infinity;
  /** After a drop's cut, later drops come from the backlog it is still draining. */
  #dropHoldUntil = -Infinity;
  #dropped = false;
  /** No queue or drop seen yet: still finding what the link carries. */
  #starting = true;
  /** The drain after the first cut: the rate it holds until when, and where it resumes. */
  #drain: { until: number; hold: number; resume: number } | undefined;
  #drained = false;
  /** Round trips of chunks sent before this (the drain's end) carry the old queue. */
  #freshFrom = -Infinity;
  /** The drain ended: the next fresh sample replaces the floor and the smoothed round trip. */
  #renewing = false;
  /** Since when queueing has stayed below `calmMs`. */
  #calmSince: number | undefined;
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
  /** `hint`: what the viewer's client says about its link; it may only start it lower. */
  constructor(limits: LinkRateLimits, hint?: MediaLinkHint) {
    this.#limits = limits;
    this.#start = Math.round(hintedStart(hint, limits.initial, limits.min));
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
   * The most bytes a viewer should have in flight (ADR 0150, amending ADR 0149): the rate for the
   * path's round trip (the floor) plus max(`backlogMs`, the round trip plus `stallMs`). One TCP
   * tail-loss recovery takes about a round trip plus the 200 ms minimum RTO, and a stall that
   * long must not drop deltas. Unbounded until a round trip is known.
   */
  get backlogBytes(): number | undefined {
    // The path's round trip (the floor), not the smoothed one: a queue must not widen its own
    // bound.
    const rtt = this.#floor[0]?.rtt ?? this.#smoothed;
    if (rtt === undefined) return undefined;
    return Math.round((this.#rate / 8) * ((rtt + Math.max(backlogMs, rtt + stallMs)) / 1000));
  }
  /**
   * Chunks went unacked past their deadline (`video-fanout.ts`): a loss. It cuts the rate as a
   * drop with a queue does, once a round trip, whatever the queueing says.
   */
  lost(at: number): void {
    if (at < this.#dropHoldUntil) return;
    this.#dropped = true;
    this.#step(at, true);
    this.#dropHoldUntil = at + (this.#smoothed ?? 0) + stepMs;
  }
  sent(sequence: number, bytes: number, at: number): void {
    if (this.#inflight.length >= outstandingSends) this.#inflight.shift();
    this.#inflight.push({ sequence, bytes, at });
  }
  /** The viewer showed every chunk up to `sequence` (acks are cumulative). */
  acknowledged(sequence: number, at: number): void {
    let newest: Sent | undefined;
    let count = 0;
    let bytes = 0;
    for (const chunk of this.#inflight) {
      if (chunk.sequence > sequence) break;
      newest = chunk;
      count++;
      bytes += chunk.bytes;
    }
    if (!newest) return;
    this.#delivered.add(at, bytes);
    this.#inflight.splice(0, count);
    // The chunk's own time on the wire is not queueing: a keyframe on a thin link takes long.
    // It is judged at the target rate, which may be far below a fast link's, so it only ever
    // takes away queueing: never below the floor, or a fast link's floor would fall to nothing.
    const rtt = at - newest.at;
    const own = (newest.bytes * 8000) / this.#rate;
    const floor = this.#floor[0]?.rtt ?? rtt;
    this.#sample(Math.max(0, Math.min(rtt, Math.max(floor, rtt - own))), newest.at, at);
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
    // The window is bounded in time, so a chunk the encoder made too big is dropped on a calm
    // link too: only a drop with a queue behind it says the link is too slow.
    const floor = this.#floor[0]?.rtt;
    if (floor !== undefined && (this.#smoothed ?? floor) - floor < queuedMs) return;
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
    if (sentAt < this.#freshFrom) return;
    if (this.#renewing) {
      // A fresh sample can only overstate the path's round trip (another flow may be queued
      // on it): it replaces the smoothed round trip, and the floor only if it is lower.
      this.#renewing = false;
      this.#smoothed = rtt;
      const floor = this.#floor[0]?.rtt ?? rtt;
      this.#floor = [{ at, rtt: Math.min(floor, rtt) }];
      return;
    }
    if (sentAt < this.#stall.sentBefore && at <= this.#stall.until) return;
    if (this.#stalls(rtt, at, true)) return this.#stalled(at, rtt - (this.#smoothed ?? 0));
    const value = this.#smoothed === undefined ? rtt : this.#smoothed * 0.875 + rtt * 0.125;
    this.#smoothed = value;
    while (this.#floor.length && (this.#floor.at(-1)?.rtt ?? 0) >= value) this.#floor.pop();
    this.#floor.push({ at, rtt: value });
    while (this.#floor.length > 1 && (this.#floor[0]?.at ?? at) < at - floorWindowMs)
      this.#floor.shift();
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
    const rates = this.#delivered.rates(at);
    const delivered = rates.recent;
    const floor = this.#floor[0]?.rtt ?? 0;
    const queueing = (this.#smoothed ?? floor) - floor;
    const proven = this.#provenRate(at, delivered);
    if (queueing > queuedMs) this.#queuedSince ??= at;
    else this.#queuedSince = undefined;
    // Calm within the path's jitter: a long round trip jitters more than a short one.
    const calm = Math.max(calmMs, floor * calmShare);
    if (queueing < calm) this.#calmSince ??= at;
    else this.#calmSince = undefined;
    let rate = this.#rate;
    // Waiting for a fresh round trip: only a drop (a link that stopped carrying) moves it.
    if (this.#renewing && !this.#dropped) return;
    if (this.#drain) {
      this.#dropped = false;
      if (at < this.#drain.until) return this.#settle(this.#drain.hold);
      // Drained: the floor and the smoothed round trip start afresh from the first chunk sent
      // from now. Until it is acked the rate holds, and the old round trip still bounds what
      // is in flight.
      this.#freshFrom = at;
      this.#renewing = true;
      this.#queuedSince = undefined;
      this.#calmSince = undefined;
      this.#holdUntil = at + stepMs;
      const resume = this.#drain.resume;
      this.#drain = undefined;
      return this.#settle(resume);
    }
    const cut = (to: number) => {
      this.#starting = false;
      rate = Math.max(rate * deepest, Math.min(rate, to));
      this.#holdUntil = at + (this.#smoothed ?? 0) + stepMs;
      this.#queuedSince = undefined;
      if (this.#drained) return;
      // The first cut drains what the start queued, for about a round trip, then resumes at
      // what the link delivered: the start was a guess, so `deepest` doesn't hold it up.
      this.#drained = true;
      const before = this.#rate;
      // What the link carries now: the last second, not a longer window from before it slowed.
      const carried = delivered || before;
      const resume = Math.min(before, carried * deliveredShare);
      const hold = Math.min(resume, carried * drainShare);
      // Half the rate for twice the queueing (smoothed round trip less the floor) empties it;
      // at least a path round trip, so a fresh sample can show.
      const queued = Math.max(0, (this.#smoothed ?? floor) - floor);
      this.#drain = { until: at + Math.max(stepMs, floor, 2 * queued), hold, resume };
      rate = hold;
    };
    // A drop (the time bound held a chunk back) brings the rate to what the link delivered,
    // as a lasting queue does: the bound itself keeps the lag down, and the first cut's drain
    // empties a queue of our own. The 2 s window covers a stall's gap.
    if (this.#dropped) cut(Math.max(delivered, rates.longer) * deliveredShare || rate * dropFall);
    else if (this.#queuedSince !== undefined) {
      // A queue that lasts cuts only if the link delivered less than the rate: when it carried
      // all of it, the queue is another flow's, and cutting would only hand it the link.
      const short = Math.max(delivered, rates.longer) < rate * carriedShare;
      if (at >= this.#holdUntil && at - this.#queuedSince >= persistMs && short)
        cut(Math.max(delivered, rates.longer) * deliveredShare);
    } else if (queueing < calm && at >= this.#holdUntil && at - this.#lastRise >= floor) {
      // Once a path round trip (the floor, not one a queue inflates): what a rise did shows then.
      this.#lastRise = at;
      const since = this.#calmSince ?? at;
      const probe = at - since >= calmRtts * Math.max(stepMs, floor);
      rate = Math.max(
        rate,
        Math.min(
          rate * (this.#starting ? startRise : probe ? probeRise : rise),
          Math.max(this.#start, proven * headroom),
        ),
      );
    }
    this.#dropped = false;
    this.#settle(rate);
  }
  #settle(rate: number): void {
    const { min, max } = this.#limits;
    this.#rate = Math.round(Math.min(max, Math.max(min, rate)));
  }
}
