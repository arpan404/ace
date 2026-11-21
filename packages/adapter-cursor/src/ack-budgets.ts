/** Why a frame's storage wait ended without ace's acknowledgement. */
export const ackExpired = "ace took too long to store a Cursor SDK frame (acknowledgement expired)";

interface Pending {
  until: number;
  /** Whether request deadlines bound this budget: false for a frame no request waits on. */
  bounded: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** One frame's wait for ace to store it. */
export interface AckBudget {
  /** Aborts when the budget runs out; the wire then stops waiting, the write included. */
  signal: AbortSignal;
  /** True once the budget has run out, even if its timer has not fired yet. */
  spent(): boolean;
  release(): void;
}

/**
 * The storage budgets of frames waiting for ace. Each frame gets its own budget from when it was
 * emitted, never past the deadline of any request in flight. A request that starts while frames
 * wait re-arms them at once: ace stops waiting for that request at its deadline, and frames the
 * request waits on must not outlast it.
 */
export class AckBudgets {
  #now: () => number;
  #deadlines: number[] = [];
  #pending = new Set<Pending>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** A request's deadline, counted from when it arrived; the returned call ends it. */
  within(ms: number): () => void {
    const deadline = this.#now() + ms;
    this.#deadlines.push(deadline);
    this.#rearm();
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#deadlines.splice(this.#deadlines.indexOf(deadline), 1);
      this.#rearm();
    };
  }

  /** A budget of `ms` from now, bounded by every request deadline while it lasts. */
  start(ms: number): AckBudget {
    return this.#start(ms, true);
  }

  /** A budget of `ms` from now for a frame no request waits on, such as a fence notice. */
  startDetached(ms: number): AckBudget {
    return this.#start(ms, false);
  }

  #start(ms: number, bounded: boolean): AckBudget {
    const pending: Pending = {
      until: this.#now() + ms,
      bounded,
      controller: new AbortController(),
      timer: undefined,
    };
    this.#pending.add(pending);
    this.#arm(pending);
    return {
      signal: pending.controller.signal,
      spent: () => pending.controller.signal.aborted || this.#left(pending) <= 0,
      release: () => {
        clearTimeout(pending.timer);
        this.#pending.delete(pending);
      },
    };
  }

  #left(pending: Pending): number {
    return (
      (pending.bounded ? Math.min(pending.until, ...this.#deadlines) : pending.until) - this.#now()
    );
  }

  #arm(pending: Pending): void {
    clearTimeout(pending.timer);
    const left = this.#left(pending);
    if (left > 0) {
      pending.timer = setTimeout(() => this.#arm(pending), left);
      return;
    }
    this.#pending.delete(pending);
    pending.controller.abort(new Error(ackExpired));
  }

  #rearm(): void {
    for (const pending of this.#pending) this.#arm(pending);
  }
}
