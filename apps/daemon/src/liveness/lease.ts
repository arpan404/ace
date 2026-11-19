/*
 * No proof of life means not live (ADR 0052, "Stop and proof of life"). Every live state has a
 * lease: an owner that renews it with proof (a report from another machine, a process that is
 * still running, a wait inside its deadline) and an expiry. A lapsed lease reads as lost contact:
 * not running, waiting or done, and it no longer holds its parent live. Proof arriving again
 * renews it. Pure: callers keep `renewedAt` and pass the time in.
 */

/** A child on another machine that hasn't reported in this long is lost contact. */
export const REMOTE_CHILD_LEASE_MS = 10 * 60_000;

export interface Lease {
  /** When the owner last showed proof of life. */
  readonly renewedAt: number;
  readonly ttlMs: number;
}

export type Contact = { readonly kind: "live"; readonly until: number } | LostContact;
export interface LostContact {
  readonly kind: "lost";
  /** When the lease ran out: the last proof of life plus its time to live. */
  readonly since: number;
}

export function contact(lease: Lease, now: number): Contact {
  const until = lease.renewedAt + lease.ttlMs;
  // Proof stamped ahead of the clock (it went back) still counts only for one lease.
  if (now < until || now < lease.renewedAt) return { kind: "live", until };
  return { kind: "lost", since: until };
}

/** The later of two proofs: a renewal never moves a lease backwards. */
export function renew(lease: Lease, at: number): Lease {
  return at > lease.renewedAt ? { ...lease, renewedAt: at } : lease;
}
