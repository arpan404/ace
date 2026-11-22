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

/**
 * One member as the held roster names them. `changed` is when WorkOS made the membership what
 * `status` says, in milliseconds; undefined when the roster didn't say.
 */
export type RosterMember = { status: string; role: string; changed?: number };

/** The roster a host holds: the backend's signed version, and when this host received it. */
export type HeldRoster = {
  org: string;
  epoch: number;
  version: number;
  /** The SHA-256 of the body, as its statement signs it. */
  digest: string;
  /** The backend's clock when it signed this roster. */
  at: number;
  /** This host's lease clock when it took it. */
  receivedAt: number;
  members: ReadonlyMap<string, RosterMember>;
};

type Signed = Pick<HeldRoster, "epoch" | "version" | "digest" | "at">;

/**
 * What a host does with a verified roster, given the one it holds (§7.2):
 * - a higher epoch (the backend's database was restored) starts a new series: `take`;
 * - a lower epoch, or a lower version in the same epoch, is refused, so an old roster that still
 *   listed a removed member can't be replayed to bring them back;
 * - the same version is taken again only with the same body, signed later (`refresh`): its
 *   members don't change, only its time moves on. The same version with another body is refused.
 */
export function rosterStep(
  held: Signed | undefined,
  incoming: Signed,
): "take" | "refresh" | "refuse" {
  if (!held || incoming.epoch > held.epoch) return "take";
  if (incoming.epoch < held.epoch) return "refuse";
  if (incoming.version > held.version) return "take";
  if (incoming.version === held.version && incoming.digest === held.digest && incoming.at > held.at)
    return "refresh";
  return "refuse";
}

/**
 * The roster's time for freshness: the backend's signing time, never later than when it
 * arrived, so a roster dated in this host's future can't buy its members time.
 */
export function rosterTime(roster: Pick<HeldRoster, "at" | "receivedAt">): number {
  return Math.min(roster.at, roster.receivedAt);
}

const clampMinutes = (minutes: number) =>
  Math.min(MAX_OFFLINE_MINUTES, Math.max(0, Math.floor(minutes)));

/**
 * The offline allowance in milliseconds: the policy's `threads.offline_minutes`, else 60, kept
 * within 0 to 1,440 minutes, and never above the host's own ceiling. Lower is stricter, so each
 * side only narrows (§7.1, §8).
 */
export function offlineAllowanceMs(
  policyMinutes: number | undefined,
  hostMinutes?: number,
): number {
  const policy = clampMinutes(policyMinutes ?? DEFAULT_OFFLINE_MINUTES);
  const minutes = hostMinutes === undefined ? policy : Math.min(policy, clampMinutes(hostMinutes));
  return minutes * 60_000;
}

/**
 * How the last roster fetch went. Only `unreachable` (no answer at all: the network, a timeout,
 * the backend's edge failing) earns the offline allowance. A backend that answers and refuses
 * (401, 403, a bad signature, another host's roster, a stale one) earns none: something is
 * wrong with this host's standing, not with the network. `unknown` until the first fetch after
 * a start.
 */
export type Reachability = "ok" | "unreachable" | "refused" | "unknown";

/**
 * Whether `account` may run work here now: not durably revoked, `active` on the held roster,
 * and that roster recent enough. Two minutes always; the offline allowance only while the
 * backend can't be reached at all (§7.1).
 */
export function mayRun(input: {
  account: string;
  roster: HeldRoster | undefined;
  revoked: boolean;
  now: number;
  offlineMs: number;
  reachability: Reachability;
}): boolean {
  const { roster } = input;
  if (input.revoked || !roster) return false;
  if (roster.members.get(input.account)?.status !== "active") return false;
  const window =
    input.reachability === "unreachable"
      ? Math.max(memberWorkTimes.freshRosterMs, input.offlineMs)
      : memberWorkTimes.freshRosterMs;
  return input.now - rosterTime(roster) <= window;
}

/** Why a member's work was stopped: shown on the tree, never as done. */
export type StopReason = "revoked" | "lease_expired" | "stopped";

export type Lease = { root: string; account: string; expiresAt: number };

/** A durable revocation: the WorkOS time of the state that revoked the member. */
export type Revocation = { account: string; changed: number };

/**
 * Who a new roster revokes and whose revocation it lifts (§7.2). It revokes every member it
 * lists as anything but `active`, and every account this host knew (an earlier roster's member,
 * a lease's owner) that it no longer lists, at the roster's own time. It lifts a revocation only
 * for a member it lists as active in a state WorkOS made after the revoking one, so a backend
 * restored from a backup that predates a removal can't bring the member back.
 */
export function revocationChanges(
  roster: Pick<HeldRoster, "members" | "at">,
  known: Iterable<string>,
  revoked: ReadonlyMap<string, number>,
): { revoke: Revocation[]; clear: string[] } {
  const revoke = new Map<string, number>();
  const clear: string[] = [];
  for (const [account, member] of roster.members) {
    if (member.status !== "active") revoke.set(account, member.changed ?? roster.at);
    else {
      const since = revoked.get(account);
      if (since !== undefined && member.changed !== undefined && member.changed > since)
        clear.push(account);
    }
  }
  for (const account of known) if (!roster.members.has(account)) revoke.set(account, roster.at);
  return {
    revoke: [...revoke]
      .map(([account, changed]) => ({ account, changed }))
      .toSorted((a, b) => (a.account < b.account ? -1 : 1)),
    clear: clear.toSorted(),
  };
}

/**
 * One reconciliation pass (§7.2): a lease of a revoked owner stops now, and so does one that has
 * run out, which is never renewed however fresh the roster; a lease of an owner who may still
 * run work is renewed for another fifteen minutes; any other is left to run out. Work is
 * proportional to the leases held.
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
    else if (lease.expiresAt <= input.now) stop.push({ ...lease, reason: "lease_expired" });
    else if (input.mayRun(lease.account))
      renew.push({ ...lease, expiresAt: input.now + memberWorkTimes.leaseMs });
  }
  return { renew, stop };
}

/**
 * The lease clock (§7.1): it never runs slower than the monotonic clock, so a wall clock
 * stepped backwards buys nobody time, and it follows the wall clock forward, so time a host
 * spent suspended counts. It never goes back. `trusted` is false when the wall clock at start
 * was behind the last time this host recorded: how long it was down is unknown, so a roster
 * held from before the start renews nothing.
 */
export function leaseClock(input: {
  wall: () => number;
  monotonic: () => number;
  /** The latest lease time this host recorded before it started. */
  highWater: number | undefined;
}) {
  const startWall = input.wall();
  const trusted = input.highWater === undefined || startWall >= input.highWater;
  let last = Math.max(startWall, input.highWater ?? Number.NEGATIVE_INFINITY);
  let lastMono = input.monotonic();
  return {
    trusted,
    /** When this run's lease clock started. */
    startedAt: last,
    now(): number {
      const mono = input.monotonic();
      last = Math.max(last + Math.max(0, mono - lastMono), input.wall());
      lastMono = mono;
      return last;
    },
  };
}
