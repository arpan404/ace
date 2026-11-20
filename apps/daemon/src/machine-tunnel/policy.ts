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
}

/**
 * A page loads over a handful of keep-alive connections per port, plus its websockets, so 256
 * streams leave room for many tabs. A Vite page's first load opens a few dozen; the burst covers
 * a reload storm, and the rate a page that keeps opening fresh connections.
 */
export const defaultTunnelLimits: TunnelLimits = {
  streamsPerDevice: 256,
  opensPerSecond: 100,
  openBurst: 200,
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

type Bucket = { tokens: number; at: number; open: Set<string> };

/**
 * Per-device stream and open-rate limits. `admit` reserves a slot for a stream, keyed by
 * whatever the caller names it by; `release` frees it. A device with nothing open and a full
 * bucket is forgotten, so the map holds only devices in use.
 */
export class TunnelAdmission {
  readonly #limits: TunnelLimits;
  readonly #now: () => number;
  readonly #devices = new Map<string, Bucket>();
  constructor(now: () => number, limits: TunnelLimits = defaultTunnelLimits) {
    this.#now = now;
    this.#limits = limits;
  }
  /** Reserve a stream for `device` under the key `stream`, or say why not. */
  admit(
    device: string,
    stream: string,
    facts: { enabled: boolean; operate: boolean; port: number; acePorts: ReadonlySet<number> },
  ): TunnelRefusalCode | undefined {
    const access = tunnelAccess(facts);
    if (access) return access;
    if (facts.acePorts.has(facts.port)) return "tunnel_port_refused";
    const now = this.#now();
    const bucket = this.#devices.get(device) ?? {
      tokens: this.#limits.openBurst,
      at: now,
      open: new Set<string>(),
    };
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.tokens = Math.min(
      this.#limits.openBurst,
      bucket.tokens + elapsed * this.#limits.opensPerSecond,
    );
    bucket.at = now;
    this.#devices.set(device, bucket);
    if (bucket.open.size >= this.#limits.streamsPerDevice || bucket.tokens < 1) return "tunnel_limit";
    bucket.tokens -= 1;
    bucket.open.add(stream);
    return undefined;
  }
  release(device: string, stream: string): void {
    const bucket = this.#devices.get(device);
    if (!bucket?.open.delete(stream)) return;
    if (bucket.open.size === 0 && bucket.tokens >= this.#limits.openBurst - 1)
      this.#devices.delete(device);
  }
  /** Streams `device` holds open now. */
  open(device: string): number {
    return this.#devices.get(device)?.open.size ?? 0;
  }
}
