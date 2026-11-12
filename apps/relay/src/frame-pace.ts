import { LimitsSchema } from "./config.ts";

const relay = LimitsSchema.parse({});

/**
 * A tenth under the hosted relay's per-socket frame budget, which leaves room for clock skew
 * between the two ends and for credit fragments.
 */
export const streamPace = {
  perSecond: relay.messagesPerSecond * 0.9,
  burst: relay.messageBurst * 0.9,
};

/**
 * How fast one relayed stream may write frames so ace's hosted relay never closes it for rate. A
 * Durable Object can't pause a socket, so a socket past its frame budget is closed (ADR 0110);
 * the sender keeps itself under it instead. Each frame reserves the next slot, and `take` says
 * how long to wait before writing it. Pure: time comes in as `now`.
 */
export class FramePace {
  readonly #rate: number;
  readonly #burst: number;
  #tokens: number;
  #at: number | undefined;
  constructor(options: { perSecond: number; burst: number } = streamPace) {
    this.#rate = options.perSecond;
    this.#burst = options.burst;
    this.#tokens = options.burst;
  }
  /** Reserve one frame at `now`: milliseconds to wait before writing it, 0 to write it now. */
  take(now: number): number {
    const elapsed = this.#at === undefined ? 0 : Math.max(0, now - this.#at);
    this.#at = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + (elapsed * this.#rate) / 1000) - 1;
    return this.#tokens >= 0 ? 0 : Math.ceil((-this.#tokens * 1000) / this.#rate);
  }
}
