import type { Scheduler } from "@ace/client";

/** Progress reaches Swift at most this often (ms): about ten times a second, never per chunk. */
export const progressEvery = 100;

/**
 * Holds back progress that lands sooner than `progressEvery` after the last rows went out, and
 * sends it once the interval is up, so a stalled upload still shows the last part that landed.
 * Its timer comes from `set` (the host scheduler on the phone, where JavaScriptCore has no
 * `setTimeout`).
 */
export class ProgressThrottle {
  readonly #now: () => number;
  readonly #set: Scheduler["set"];
  readonly #send: () => void;
  #sentAt = Number.NEGATIVE_INFINITY;
  #cancel: (() => void) | undefined;

  constructor(now: () => number, set: Scheduler["set"], send: () => void) {
    this.#now = now;
    this.#set = set;
    this.#send = send;
  }

  /** Something moved: send now, or once the interval since the last send is up. */
  progressed(): void {
    const wait = progressEvery - (this.#now() - this.#sentAt);
    if (wait <= 0) this.#send();
    else
      this.#cancel ??= this.#set(wait, () => {
        this.#cancel = undefined;
        this.#send();
      });
  }

  /** The rows went out (any change, throttled or not): a held-back send is no longer needed. */
  sent(): void {
    this.stop();
    this.#sentAt = this.#now();
  }

  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
}
