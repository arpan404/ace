/** Progress reaches Swift at most this often (ms): about ten times a second, never per chunk. */
export const progressEvery = 100;

/**
 * Holds back progress that lands sooner than `progressEvery` after the last rows went out, and
 * sends it once the interval is up, so a stalled upload still shows the last part that landed.
 */
export class ProgressThrottle {
  readonly #now: () => number;
  readonly #send: () => void;
  #sentAt = Number.NEGATIVE_INFINITY;
  #trailing: ReturnType<typeof setTimeout> | undefined;

  constructor(now: () => number, send: () => void) {
    this.#now = now;
    this.#send = send;
  }

  /** Something moved: send now, or once the interval since the last send is up. */
  progressed(): void {
    const wait = progressEvery - (this.#now() - this.#sentAt);
    if (wait <= 0) this.#send();
    else this.#trailing ??= setTimeout(() => this.#send(), wait);
  }

  /** The rows went out (any change, throttled or not): a held-back send is no longer needed. */
  sent(): void {
    this.stop();
    this.#sentAt = this.#now();
  }

  stop(): void {
    clearTimeout(this.#trailing);
    this.#trailing = undefined;
  }
}
