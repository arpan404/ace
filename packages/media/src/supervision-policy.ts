/** The supervision rules of docs/media/plan.md ("Supervision"), as pure values and functions. */

export type MediaHealth = "healthy" | "restarting" | "unavailable";

export const supervisionTimings = {
  readyMs: 5_000,
  pingMs: 5_000,
  /** A ping is missed when no pong comes within this long after the ping was written. */
  pongMs: 5_000,
  missedPongs: 3,
  /** Ping intervals with normal-lane bytes pending and no write completing before the child is hung. */
  stalledTicks: 6,
  revocationMs: 250,
  idleMs: 60_000,
  shutdownGraceMs: 5_000,
  healthyResetMs: 60_000,
  crashWindowMs: 120_000,
  crashLimit: 5,
  unavailableMs: 600_000,
} as const;

/** Restart delay after the `attempt`th consecutive failure: 0.5 s doubling to 30 s, ±20 %. */
export function restartDelay(attempt: number, random: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (1 + 0.2 * (2 * random - 1)));
}

/** Failure times still inside the crash-loop window, and whether they reach the limit. */
export function crashLoop(failures: readonly number[], now: number) {
  const recent = failures.filter((at) => now - at < supervisionTimings.crashWindowMs);
  return { recent, looping: recent.length >= supervisionTimings.crashLimit };
}

/**
 * The init this build sends, as a level `ace-media --init-level` must report at least. Level 2:
 * init carries no media settings (ADR 0201). A binary from before it answers nothing (it reads
 * init from stdin, which the probe closes), and would refuse this init.
 */
export const mediaInitLevel = 2;

/** What a live view and a recording say when the binary is older than this daemon. */
export const olderMediaReason =
  "Live video can't start: this ace-media is older than ace. Update ace or rebuild native/media.";

/** Whether `--init-level`'s output names a level this daemon can start. Pure. */
export function speaksInit(output: string): boolean {
  const level = /^\s*(\d+)\s*$/.exec(output)?.[1];
  return level !== undefined && Number(level) >= mediaInitLevel;
}
