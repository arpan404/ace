/*
 * Execution leases, rosters and revocation on an org host (ADR 0209 §7), as pure rules: what a
 * host takes from a roster, who may run work, and what each reconciliation pass renews or stops.
 * No clock, storage or process here; the shell in `member-work.ts` brings them.
 */

export const memberWorkTimes = {
  /** A lease lasts this long past its last renewal (§7.1). */
  leaseMs: 15 * 60_000,
  /** A roster this young renews leases whatever the offline allowance says (§7.1). */
  freshRosterMs: 2 * 60_000,
  /** How often the host fetches its roster and runs a pass (§7.2). */
  pollMs: 60_000,
};
/** `threads.offline_minutes` when the policy sets none, and the most it may set (§7.1, §8). */
export const DEFAULT_OFFLINE_MINUTES = 60;
export const MAX_OFFLINE_MINUTES = 1440;

/** One member as the held roster names them. */
export type RosterMember = { status: string; role: string };

/** The roster a host holds: the backend's signed version, and when this host received it. */
export type HeldRoster = {
  org: string;
  version: number;
  /** The backend's clock when it signed this roster. */
  at: number;
  /** This host's clock when it took it. */
  receivedAt: number;
  members: ReadonlyMap<string, RosterMember>;
};

/**
 * What a host does with a verified roster, given the one it holds: `take` a higher version,
 * `refresh` the same version signed later (the members are the same; only its time moves on),
 * and `refuse` anything lower or older. A lower version is never taken, so an old roster that
 * still listed a removed member can't be replayed to bring them back (§7.2).
 */
export function rosterStep(
  held: { version: number; at: number } | undefined,
  incoming: { version: number; at: number },
): "take" | "refresh" | "refuse" {
  if (!held || incoming.version > held.version) return "take";
  if (incoming.version === held.version && incoming.at > held.at) return "refresh";
  return "refuse";
}

/**
 * The roster's time for freshness: the backend's signing time, never later than when it
 * arrived, so a roster dated in this host's future can't buy its members time.
 */
export function rosterTime(roster: Pick<HeldRoster, "at" | "receivedAt">): number {
  return Math.min(roster.at, roster.receivedAt);
}

const clamp = (minutes: number) => Math.min(MAX_OFFLINE_MINUTES, Math.max(0, Math.floor(minutes)));

/**
 * The offline allowance in milliseconds: the policy's `threads.offline_minutes`, else 60, kept
 * within 0 to 1,440 minutes, and never above the host's own ceiling. Lower is stricter, so each
 * side only narrows (§7.1, §8).
 */
export function offlineAllowanceMs(
  policyMinutes: number | undefined,
  hostMinutes?: number,
): number {
  const policy = clamp(policyMinutes ?? DEFAULT_OFFLINE_MINUTES);
  const minutes = hostMinutes === undefined ? policy : Math.min(policy, clamp(hostMinutes));
  return minutes * 60_000;
}

/**
 * Whether `account` may run work here now: not durably revoked, `active` on the held roster,
 * and that roster recent enough, within two minutes or the offline allowance, whichever is
 * longer (§7.1).
 */
export function mayRun(input: {
  account: string;
  roster: HeldRoster | undefined;
  revoked: boolean;
  now: number;
  offlineMs: number;
}): boolean {
  const { roster } = input;
  if (input.revoked || !roster) return false;
  if (roster.members.get(input.account)?.status !== "active") return false;
  const window = Math.max(memberWorkTimes.freshRosterMs, input.offlineMs);
  return input.now - rosterTime(roster) <= window;
}

/** Why a member's work was stopped: shown on the tree, never as done. */
export type StopReason = "revoked" | "lease_expired" | "stopped";

export type Lease = { root: string; account: string; expiresAt: number };

/**
 * Who a new roster revokes and whose revocation it lifts (§7.2): every member it lists as
 * anything but `active`, and every account this host knew (an earlier roster's member, or a
 * lease's owner) that it no longer lists. Only a roster that shows a member active clears them.
 */
export function revocationChanges(
  roster: Pick<HeldRoster, "members">,
  known: Iterable<string>,
): { revoke: string[]; clear: string[] } {
  const revoke = new Set<string>();
  const clear: string[] = [];
  for (const [account, member] of roster.members)
    if (member.status === "active") clear.push(account);
    else revoke.add(account);
  for (const account of known) if (!roster.members.has(account)) revoke.add(account);
  return { revoke: [...revoke].toSorted(), clear: clear.toSorted() };
}

/**
 * One reconciliation pass (§7.2): each lease of a revoked owner stops now; each lease of an
 * owner who may still run is renewed for another fifteen minutes; any other lease stops once it
 * has run out, and is otherwise left to run out. Work is proportional to the leases held.
 */
export function reconcile(input: {
  now: number;
  leases: readonly Lease[];
  revoked: (account: string) => boolean;
  mayRun: (account: string) => boolean;
}): { renew: Lease[]; stop: (Lease & { reason: StopReason })[] } {
  const renew: Lease[] = [];
  const stop: (Lease & { reason: StopReason })[] = [];
  for (const lease of input.leases) {
    if (input.revoked(lease.account)) stop.push({ ...lease, reason: "revoked" });
    else if (input.mayRun(lease.account))
      renew.push({ ...lease, expiresAt: input.now + memberWorkTimes.leaseMs });
    else if (lease.expiresAt <= input.now) stop.push({ ...lease, reason: "lease_expired" });
  }
  return { renew, stop };
}
