import { MachinePath, type MachinePathKind } from "@ace/protocol";

/**
 * Path selection for one machine (ADR 0114): which path to try first, when a measured path is
 * worth switching to, how long a failed path rests. Pure: time comes in as `now`.
 */

/** The timings ADR 0114 fixes. Tests and the manager read them from here. */
export const pathTiming = {
  /** A race starts the next path after this long without the previous one opening. */
  raceStaggerMs: 150,
  pingVisibleMs: 5_000,
  pingHiddenMs: 15_000,
  /** The warm standby only proves it is alive. */
  standbyPingMs: 30_000,
  /** A ping without its pong this long counts as a failed path. */
  pongDeadlineMs: 2_000,
  /** While on a worse path, better ones are probed this often. */
  upgradeProbeMs: 30_000,
  /** After a switch, the client stays put this long unless the path fails. */
  holdMs: 10_000,
  cooldownBaseMs: 1_000,
  cooldownCapMs: 60_000,
  /** The old path's in-flight replies may still arrive this long after a swap. */
  drainMs: 2_000,
} as const;

/** Weight of a new round trip sample in the smoothed RTT (as TCP's SRTT). */
const smoothing = 0.125;
/** A better path must be at least this much faster, relatively and absolutely. */
const minGainRatio = 0.2;
const minGainMs = 5;

const ranks: Record<MachinePathKind, number> = {
  loopback: 0,
  lan: 1,
  tailscale: 2,
  relay: 3,
  account: 4,
};
/** Lower is better: the same computer, the LAN, Tailscale, the person's relay, ace's relay. */
export function pathRank(kind: MachinePathKind): number {
  return ranks[kind];
}
/** The paths in a machine's list this build knows how to use; the rest are skipped. */
export function knownPaths(entries: readonly unknown[] | undefined): MachinePath[] {
  return (entries ?? []).flatMap((entry) => {
    const path = MachinePath.safeParse(entry);
    return path.success ? [path.data] : [];
  });
}
/** A path kind this build knows; a newer daemon's other kinds are skipped. */
export function isPathKind(value: unknown): value is MachinePathKind {
  return typeof value === "string" && Object.hasOwn(ranks, value);
}
export function isDirect(kind: MachinePathKind): boolean {
  return kind === "loopback" || kind === "lan" || kind === "tailscale";
}

/** One usable path as the planner sees it: a stable key and its kind. */
export interface PlannedPath {
  key: string;
  kind: MachinePathKind;
}
/** What the planner remembers about a path between attempts. */
export interface PathHealth {
  /** Failures in a row; a success starts over. */
  failures: number;
  /** Until when the path rests after its last failure. */
  restUntil: number;
  /** Smoothed round trip, once measured. */
  rttMs?: number;
}
export const freshHealth: PathHealth = { failures: 0, restUntil: 0 };

/** How long a path rests after its `failures`th failure in a row: 1 s, 2 s, 4 s … 60 s. */
export function restAfter(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(pathTiming.cooldownCapMs, pathTiming.cooldownBaseMs * 2 ** (failures - 1));
}
export function afterFailure(health: PathHealth, now: number): PathHealth {
  const failures = health.failures + 1;
  return { ...health, failures, restUntil: now + restAfter(failures) };
}
export function afterSuccess(health: PathHealth): PathHealth {
  return { ...health, failures: 0, restUntil: 0 };
}
export function resting(health: PathHealth | undefined, now: number): boolean {
  return health !== undefined && health.restUntil > now;
}

/** The smoothed round trip after one more sample. */
export function smoothRtt(previous: number | undefined, sampleMs: number): number {
  const sample = Math.max(0, sampleMs);
  return previous === undefined ? sample : previous + smoothing * (sample - previous);
}

/**
 * The order a race tries paths in: the last winner first, then best rank first. Resting paths
 * wait, unless every path rests: then the one whose rest ends first goes alone, so a machine
 * whose only path failed is still tried.
 */
export function raceOrder(
  paths: readonly PlannedPath[],
  health: ReadonlyMap<string, PathHealth>,
  now: number,
  lastWinner?: string,
): PlannedPath[] {
  const ranked = paths.toSorted(
    (a, b) =>
      Number(b.key === lastWinner) - Number(a.key === lastWinner) ||
      pathRank(a.kind) - pathRank(b.kind),
  );
  const ready = ranked.filter((path) => !resting(health.get(path.key), now));
  if (ready.length || !ranked.length) return ready;
  const soonest = ranked.toSorted(
    (a, b) => (health.get(a.key)?.restUntil ?? 0) - (health.get(b.key)?.restUntil ?? 0),
  )[0];
  return soonest ? [soonest] : [];
}

/** When each path in a race starts, relative to the race's start. */
export function raceSchedule(order: readonly PlannedPath[]): { path: PlannedPath; at: number }[] {
  return order.map((path, index) => ({ path, at: index * pathTiming.raceStaggerMs }));
}

/** Paths better ranked than the active one and not resting: what an upgrade check probes. */
export function upgradeCandidates(
  paths: readonly PlannedPath[],
  active: PlannedPath,
  health: ReadonlyMap<string, PathHealth>,
  now: number,
): PlannedPath[] {
  return paths
    .filter(
      (path) =>
        path.key !== active.key &&
        pathRank(path.kind) < pathRank(active.kind) &&
        !resting(health.get(path.key), now),
    )
    .toSorted((a, b) => pathRank(a.kind) - pathRank(b.kind));
}

export type SwitchVerdict = "switch" | "hold" | "not_faster" | "unmeasured";
/**
 * Whether to move from the active path to a probed one. The client stays on a path for
 * `holdMs` after switching to it. The same computer always wins over another kind, and a
 * direct path (the LAN, Tailscale) that answered its probe always wins over a relay (ADR 0115:
 * LAN, then Tailscale, then relays). Between two direct paths, or two relays, the candidate must
 * be at least 20% and 5 ms faster.
 */
export function switchVerdict(input: {
  active: PlannedPath & { rttMs: number | undefined };
  candidate: PlannedPath & { rttMs: number | undefined };
  now: number;
  switchedAt: number | undefined;
}): SwitchVerdict {
  const { active, candidate } = input;
  if (input.switchedAt !== undefined && input.now - input.switchedAt < pathTiming.holdMs)
    return "hold";
  if (candidate.kind === "loopback" && active.kind !== "loopback") return "switch";
  if (isDirect(candidate.kind) && !isDirect(active.kind)) return "switch";
  if (active.rttMs === undefined || candidate.rttMs === undefined) return "unmeasured";
  const gain = active.rttMs - candidate.rttMs;
  return gain >= minGainMs && gain >= active.rttMs * minGainRatio ? "switch" : "not_faster";
}

/**
 * The warm standby while on a direct path that may vanish (the LAN or Tailscale): the best
 * relay path that isn't resting after a failure, if any. The same computer and relay paths
 * keep none.
 */
export function standbyFor(
  paths: readonly PlannedPath[],
  active: PlannedPath,
  health: ReadonlyMap<string, PathHealth> = new Map(),
  now = 0,
): PlannedPath | undefined {
  return standbyRelays(paths, active).find((path) => !resting(health.get(path.key), now));
}

/**
 * How long until a standby can be tried again when every relay that could be one is resting
 * after a failure; undefined when one can be tried now or none is wanted. A standby that failed
 * comes back once its rest ends, so the LAN or Tailscale never stays without one.
 */
export function standbyRetryMs(
  paths: readonly PlannedPath[],
  active: PlannedPath,
  health: ReadonlyMap<string, PathHealth>,
  now: number,
): number | undefined {
  const relays = standbyRelays(paths, active);
  if (!relays.length || standbyFor(paths, active, health, now)) return undefined;
  const ends = relays.map((path) => health.get(path.key)?.restUntil ?? now);
  return Math.max(0, Math.min(...ends) - now);
}

function standbyRelays(paths: readonly PlannedPath[], active: PlannedPath): PlannedPath[] {
  if (active.kind !== "lan" && active.kind !== "tailscale") return [];
  return paths
    .filter((path) => !isDirect(path.kind))
    .toSorted((a, b) => pathRank(a.kind) - pathRank(b.kind));
}

/** How often the active path is pinged: every 5 s while visible, 15 s while hidden. */
export function pingEvery(visible: boolean): number {
  return visible ? pathTiming.pingVisibleMs : pathTiming.pingHiddenMs;
}
