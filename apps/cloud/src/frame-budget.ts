/**
 * A per-socket token bucket. The Node relay pauses a reader that runs out; a Durable Object
 * cannot pause a socket, so running out closes it. Counts live in memory and start full after
 * hibernation, which only ever forgives.
 */
export class FrameBudget {
  #rate: number;
  #burst: number;
  #tokens = new Map<string, { tokens: number; at: number }>();
  constructor(options: { perSecond: number; burst: number }) {
    this.#rate = options.perSecond;
    this.#burst = options.burst;
  }
  /** Spend one frame for `socket` at `now`; false when its budget is exhausted. */
  take(socket: string, now: number): boolean {
    const entry = this.#tokens.get(socket) ?? { tokens: this.#burst, at: now };
    const refilled = Math.min(
      this.#burst,
      entry.tokens + (Math.max(0, now - entry.at) * this.#rate) / 1000,
    );
    if (refilled < 1) {
      this.#tokens.set(socket, { tokens: refilled, at: now });
      return false;
    }
    this.#tokens.set(socket, { tokens: refilled - 1, at: now });
    return true;
  }
  forget(socket: string): void {
    this.#tokens.delete(socket);
  }
}
