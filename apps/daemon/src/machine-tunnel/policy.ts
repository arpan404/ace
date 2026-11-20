import type { TunnelRefusalCode } from "@ace/protocol";

/*
 * What the machine's tunnel to its loopback admits (ADR 0194). Pure: the facts (the setting, the
 * device's authority, the ports ace listens on, the clock) are passed in.
 */

export interface TunnelLimits {
  /** Streams one device may hold open at once, across all its tunnel connections. */
  streamsPerDevice: number;
  /** Opens one device may make per second, on average. */
  opensPerSecond: number;
  /** Opens one device may make at once before the rate applies (a page's first burst). */
  openBurst: number;
  /** Opens awaiting authorization at once, across every device and connection. */
  pendingOpens: number;
}

/**
 * A page loads over a handful of keep-alive connections per port, plus its websockets, so 256
 * streams leave room for many tabs. A Vite page's first load opens a few dozen; the burst covers
 * a reload storm, and the rate a page that keeps opening fresh connections. Authorization waits
 * at most for one shared port scan, so 64 opens in that wait is a burst's worth.
 */
export const defaultTunnelLimits: TunnelLimits = {
  streamsPerDevice: 256,
  opensPerSecond: 100,
  openBurst: 200,
  pendingOpens: 64,
};

/** Whether the tunnel as a whole serves this device now. */
export function tunnelAccess(facts: {
  enabled: boolean;
  operate: boolean;
}): TunnelRefusalCode | undefined {
  if (!facts.enabled) return "tunnel_off";
  if (!facts.operate) return "tunnel_forbidden";
  return undefined;
}

/** The ports a device sees: every listening port but ace's own, ascending, at most `limit`. */
export function visiblePorts(
  listening: Iterable<number>,
  ace: ReadonlySet<number>,
  limit: number,
): number[] {
  return [...new Set(listening)]
    .filter((port) => !ace.has(port))
    .toSorted((a, b) => a - b)
    .slice(0, limit);
}

type Bucket = { tokens: number; at: number; open: Set<string>; pending: Set<string> };

/**
 * Per-device stream and open-rate limits, and the opens awaiting authorization across every
 * device. `admit` charges an open first, whatever becomes of it, then reserves a slot for the
 * stream under whatever key the caller names it by; `authorized` ends its wait and `release`
 * frees the slot. A device is forgotten only once it holds nothing and its bucket has refilled,
 * so closing streams never buys back opens.
 */
export class TunnelAdmission {
  readonly #limits: TunnelLimits;
  readonly #now: () => number;
  readonly #devices = new Map<string, Bucket>();
  #pending = 0;
  constructor(now: () => number, limits: TunnelLimits = defaultTunnelLimits) {
    this.#now = now;
    this.#limits = limits;
  }
  /** Charge an open and reserve a stream for `device` under the key `stream`, or say why not. */
  admit(
    device: string,
    stream: string,
    facts: { enabled: boolean; operate: boolean },
  ): TunnelRefusalCode | undefined {
    const access = tunnelAccess(facts);
    if (access) return access;
    const bucket = this.#refilled(device);
    this.#devices.set(device, bucket);
    if (bucket.tokens < 1) return "tunnel_limit";
    bucket.tokens -= 1;
    if (
      this.#pending >= this.#limits.pendingOpens ||
      bucket.open.size >= this.#limits.streamsPerDevice ||
      bucket.open.has(stream)
    )
      return "tunnel_limit";
    bucket.open.add(stream);
    bucket.pending.add(stream);
    this.#pending++;
    return undefined;
  }
  /** Whether `stream` still holds its slot: false once released (a reset while it waited). */
  holds(device: string, stream: string): boolean {
    return this.#devices.get(device)?.open.has(stream) ?? false;
  }
  /** `stream`'s authorization finished, however it went. */
  authorized(device: string, stream: string): void {
    if (this.#devices.get(device)?.pending.delete(stream)) this.#pending--;
  }
  release(device: string, stream: string): void {
    const bucket = this.#devices.get(device);
    if (!bucket) return;
    this.authorized(device, stream);
    bucket.open.delete(stream);
    if (bucket.open.size === 0 && this.#refilled(device).tokens >= this.#limits.openBurst)
      this.#devices.delete(device);
  }
  /** Streams `device` holds open now. */
  open(device: string): number {
    return this.#devices.get(device)?.open.size ?? 0;
  }
  /** Opens awaiting authorization now, across every device. */
  pending(): number {
    return this.#pending;
  }
  #refilled(device: string): Bucket {
    const now = this.#now();
    const bucket = this.#devices.get(device) ?? {
      tokens: this.#limits.openBurst,
      at: now,
      open: new Set<string>(),
      pending: new Set<string>(),
    };
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.tokens = Math.min(
      this.#limits.openBurst,
      bucket.tokens + elapsed * this.#limits.opensPerSecond,
    );
    bucket.at = now;
    return bucket;
  }
}
