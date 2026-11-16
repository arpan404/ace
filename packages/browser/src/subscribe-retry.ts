import { mediaRetryCooldownMs } from "./media-route.ts";

/*
 * When a live view asks again after a subscribe failed (ADR 0147 §4), shared by every client so
 * none re-derives it: each failed request waits the source's next step on the shared ladder
 * (`MediaSubscriptions.retryDelay`, `mediaRetryDelaysMs`); once the ladder is spent, the
 * connection isn't named for the source any more (`giveUp`) and the next try waits out the
 * cooldown (`mediaRetryCooldownMs`). Something that may make a subscribe succeed (an engine
 * opened, the page shown again) may skip the wait of one ladder step, never more, and never the
 * cooldown: a page shown and hidden over and over never turns into a request each time.
 */

/** What the retry needs of a source's ladder: `MediaSubscriptions` keeps it. */
export interface RetryLadder {
  retryDelay(source: string): number | undefined;
  giveUp(source: string): void;
}

/** Runs `run` after `ms`; the result cancels it. */
export type RetrySchedule = (run: () => void, ms: number) => () => void;

export class SubscribeRetry {
  readonly #ladder: RetryLadder;
  readonly #source: string;
  readonly #schedule: RetrySchedule;
  #cancel: (() => void) | undefined;
  /** An event already skipped this step's wait: the next one waits it out. */
  #skipped = false;
  /** The ladder is spent and the wait is its cooldown, which no event skips. */
  #cooling = false;
  constructor(ladder: RetryLadder, source: string, schedule: RetrySchedule) {
    this.#ladder = ladder;
    this.#source = source;
    this.#schedule = schedule;
  }
  /** A try is waiting: nothing else asks for the source until it runs, or an event skips it. */
  get waiting(): boolean {
    return this.#cancel !== undefined;
  }
  /**
   * A subscribe request failed (whatever became of its delivery: a timeout may have settled it
   * already): `run` after the ladder's next step, or after the cooldown once the ladder is spent.
   */
  failed(run: () => void): void {
    this.#cancel?.();
    const delay = this.#ladder.retryDelay(this.#source);
    if (delay === undefined) this.#ladder.giveUp(this.#source);
    this.#skipped = false;
    this.#cooling = delay === undefined;
    this.#cancel = this.#schedule(() => {
      this.#cancel = undefined;
      this.#cooling = false;
      run();
    }, delay ?? mediaRetryCooldownMs);
  }
  /**
   * Something changed that a subscribe may now succeed on. True when it may go now: nothing is
   * waiting, or this is the first event of a ladder step (whose wait it cancels). False while
   * the cooldown runs, or once this step was skipped already.
   */
  event(): boolean {
    if (!this.#cancel) return true;
    if (this.#cooling || this.#skipped) return false;
    this.#cancel();
    this.#cancel = undefined;
    this.#skipped = true;
    return true;
  }
  /** The view went (an invalidation, an unmount): nothing waits for it any more. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#skipped = false;
    this.#cooling = false;
  }
}
