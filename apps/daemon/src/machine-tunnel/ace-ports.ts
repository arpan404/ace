/*
 * Every port an ace process listens on, which the tunnel never connects to (ADR 0194): a
 * tunnelled connection arrives from loopback, and loopback is what those listeners trust.
 *
 * Three sources, none of them a stored list:
 * - listeners in the daemon's own process are held here synchronously as they bind
 *   (`hold`), before they can accept, so no open can reach one between scans;
 * - ace's other processes' listeners are read from what those services publish (Spade's
 *   server.json, read live by `published`);
 * - a scan of ace's processes (`scanned`) supplements both, for anything they don't name.
 *
 * Asked without a recent successful scan, the answer is `unknown`, which the tunnel treats as
 * refused: it fails closed. Pure: the clock and the scan results are handed in.
 */

export type PortOwnership = "ace" | "free" | "unknown";

export interface AcePortsOptions {
  /** Ports ace listeners publish, read at every question (the gateway's, Spade's). */
  published(): Iterable<number | undefined>;
  /** A monotonic clock, in ms. */
  now(): number;
  /** How old a scan may be before an open asks for a new one; 1 s unless given. */
  scanMs?: number;
  /**
   * How old the last successful scan may be and still say a port is free; 5 s unless given.
   * Past it, or after a failed scan, every port not known to be ace's is `unknown`.
   */
  staleMs?: number;
}

export class AcePorts {
  readonly scanMs: number;
  readonly staleMs: number;
  readonly #options: AcePortsOptions;
  readonly #held = new Map<number, number>();
  #scan: { at: number; owned: ReadonlySet<number> } | undefined;
  #failed = false;
  /** Every port last known to be ace's, to tell which are new. */
  #known = new Set<number>();
  readonly #listeners = new Set<(port: number) => void>();

  constructor(options: AcePortsOptions) {
    this.#options = options;
    this.scanMs = options.scanMs ?? 1000;
    this.staleMs = Math.max(this.scanMs, options.staleMs ?? 5000);
  }

  /** Holds `port` as ace's until the returned release is called (counted per hold). */
  hold(port: number): () => void {
    this.#held.set(port, (this.#held.get(port) ?? 0) + 1);
    this.#announce();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#held.get(port) ?? 1) - 1;
      if (left > 0) this.#held.set(port, left);
      else this.#held.delete(port);
    };
  }

  /** A scan of ace's processes that started at `at`: the ports they hold, or undefined if it failed. */
  scanned(at: number, owned: ReadonlySet<number> | undefined): void {
    if (!owned) {
      this.#failed = true;
      return;
    }
    if (this.#scan && at < this.#scan.at) return;
    this.#failed = false;
    this.#scan = { at, owned };
    this.#announce();
  }

  /** Whether the last scan succeeded and is at most `scanMs` old. */
  fresh(): boolean {
    return this.#within(this.scanMs);
  }

  /**
   * Whose `port` is, now. Synchronous, so a caller asks right before it connects: a listener in
   * this process that bound before the question is already held.
   */
  ownership(port: number): PortOwnership {
    if (this.#held.has(port)) return "ace";
    for (const published of this.#options.published()) if (published === port) return "ace";
    if (this.#scan?.owned.has(port)) return "ace";
    return this.#within(this.staleMs) ? "free" : "unknown";
  }

  /** Every port known to be ace's now. */
  all(): Set<number> {
    const ports = new Set([...this.#held.keys(), ...(this.#scan?.owned ?? [])]);
    for (const port of this.#options.published()) if (port !== undefined) ports.add(port);
    return ports;
  }

  /** Hear a port become ace's (held, published or scanned); returns how to stop. */
  onProtected(listener: (port: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #within(ms: number): boolean {
    return !this.#failed && this.#scan !== undefined && this.#options.now() - this.#scan.at <= ms;
  }

  #announce(): void {
    const now = this.all();
    const added = [...now].filter((port) => !this.#known.has(port));
    this.#known = now;
    for (const port of added) for (const listener of this.#listeners) listener(port);
  }
}
