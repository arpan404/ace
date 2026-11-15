/**
 * Named network links the shaper applies (link-shaper.ts). Rates are bits per second at the
 * bottleneck; `null` means unshaped. `rttMs` is the round trip the link adds, split evenly
 * between the two directions. `loss` is the fraction of TCP segments that are lost; TCP hides
 * the loss from the application as a stall of `stallMs` (about one retransmission timeout)
 * before that segment and everything after it arrive. `queueBytes` bounds the bytes waiting
 * at the bottleneck in each direction; past it the sender is paused, as a full send window
 * pauses it, so nothing is dropped.
 */
export interface LinkProfile {
  name: string;
  /** Server to client. */
  downBitsPerSecond: number | null;
  /** Client to server. */
  upBitsPerSecond: number | null;
  rttMs: number;
  loss: number;
  stallMs: number;
  queueBytes: number;
}

export const linkProfiles = {
  /** A poor phone network: the owner's target for daemon data (2026-11-14). */
  "3g-slow": {
    name: "3g-slow",
    downBitsPerSecond: 400_000,
    upBitsPerSecond: 200_000,
    rttMs: 400,
    loss: 0.02,
    // Linux computes RTO as srtt + 4 * rttvar with a 200 ms floor: about 1.5 RTT on a steady link.
    stallMs: 600,
    queueBytes: 64 * 1024,
  },
  /** A usable phone network or relayed tunnel, the profile web-perf's slow-link run had. */
  "3g-fast": {
    name: "3g-fast",
    downBitsPerSecond: 1_600_000,
    upBitsPerSecond: 750_000,
    rttMs: 300,
    loss: 0.01,
    stallMs: 450,
    queueBytes: 64 * 1024,
  },
  /** No shaping: the same path at loopback speed, the floor the others are read against. */
  lan: {
    name: "lan",
    downBitsPerSecond: null,
    upBitsPerSecond: null,
    rttMs: 0,
    loss: 0,
    stallMs: 0,
    queueBytes: 64 * 1024,
  },
} as const satisfies Record<string, LinkProfile>;

export type LinkProfileName = keyof typeof linkProfiles;

export function linkProfile(name: string): LinkProfile {
  if (!(name in linkProfiles))
    throw new Error(`Unknown link profile ${name}; use ${Object.keys(linkProfiles).join(", ")}`);
  return linkProfiles[name as LinkProfileName];
}

/** A small deterministic generator, so a profile's losses fall on the same segments every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
