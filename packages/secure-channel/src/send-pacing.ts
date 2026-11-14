import { FLOW_WINDOW } from "./flow-credit.ts";

/**
 * How often a receiver that announced lanes returns credit: once 32 KiB is consumed, instead of
 * a quarter window. A full data fragment costs more than that, so each one read returns its
 * credit at once; a credit only goes as a fragment is read, so a receiver never sends more
 * credits than it reads data fragments, and a relay's per-socket frame budget holds.
 */
export const LANE_CREDIT_STEP = 32 * 1024;
/**
 * Two full fragments: with less, the sender would stop every round trip waiting for the credit
 * of the one fragment it has out.
 */
export const MIN_IN_FLIGHT = 128 * 1024;
/** To start with: a quarter window, the most an older reader leaves unacknowledged. */
const START_IN_FLIGHT = 256 * 1024;
/** What the limit moves by on each acknowledged fragment: about one full fragment. */
const STEP = 64 * 1024;
/** Queueing below this much extra round trip still counts as an empty queue. */
const QUEUE_SLACK_MS = 10;

interface Sent {
  at: number;
  /** Cumulative cost sent once this fragment went. */
  through: number;
}

/**
 * The sender's own limit on unacknowledged bytes, below the window the reader grants, so
 * little sits queued in the relay ahead of the next interactive fragment while the path stays
 * full. Measured from how fast credit comes back: the shortest round trip a credit took is the
 * path's own delay. While the sender has more to send than the limit lets out, each credit
 * whose fragment came back within half that delay again (nothing queued) raises the limit by
 * a fragment, so it doubles each round trip; one that came back later (bytes queued ahead of
 * it) cuts it by a quarter, at most once a round trip. The limit settles around a queue of half
 * a round trip: one to two bandwidth-delay products in flight.
 *
 * Only for a reader that announced lanes: it credits every `LANE_CREDIT_STEP`, well under the
 * floor of `MIN_IN_FLIGHT`, so the sender always gets credit back. Pure; times are milliseconds
 * the caller passes in.
 */
export class InFlightCap {
  #sent = 0;
  #credited = 0;
  #log: Sent[] = [];
  #baseDelay = Infinity;
  #limit = START_IN_FLIGHT;
  #waited = false;
  /** After a cut, what had been sent: credits for it show the queue from before the cut. */
  #cutAt = 0;

  get inFlight(): number {
    return this.#sent - this.#credited;
  }

  /** The current limit on cost in flight. */
  get limit(): number {
    return this.#limit;
  }

  /** Whether a fragment of `cost` may go now. Nothing in flight always may. */
  allows(cost: number): boolean {
    return this.inFlight === 0 || this.inFlight + cost <= this.#limit;
  }

  /** The sender has data it may not send yet: the next credit says whether to raise the limit. */
  waiting(): void {
    this.#waited = true;
  }

  spent(cost: number, now: number): void {
    this.#sent += cost;
    this.#log.push({ at: now, through: this.#sent });
  }

  credited(amount: number, now: number): void {
    if (amount <= 0) return;
    this.#credited += amount;
    let acked: Sent | undefined;
    while (this.#log[0] && this.#log[0].through <= this.#credited) acked = this.#log.shift();
    if (!acked) return;
    const delay = now - acked.at;
    this.#baseDelay = Math.min(this.#baseDelay, delay);
    const waited = this.#waited;
    this.#waited = false;
    // A sender with nothing more to send learns nothing about how much the path holds.
    if (!waited) return;
    // Fragments sent before the last cut were queued behind what it took out: they say nothing.
    if (acked.through <= this.#cutAt) return;
    const queued = delay - this.#baseDelay > Math.max(this.#baseDelay / 2, QUEUE_SLACK_MS);
    if (!queued) {
      this.#limit = Math.min(FLOW_WINDOW, this.#limit + STEP);
      return;
    }
    this.#limit = Math.max(MIN_IN_FLIGHT, Math.floor((this.#limit * 3) / 4));
    this.#cutAt = this.#sent;
  }
}
