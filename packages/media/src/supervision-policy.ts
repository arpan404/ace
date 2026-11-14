import type { ToMedia } from "./wire.ts";

/** The supervision rules of docs/media/plan.md ("Supervision"), as pure values and functions. */

export type MediaSettings = Extract<ToMedia, { type: "init" }>["settings"];
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

/** The setting gate: ace-media is only ever started while some setting asks for it. */
export function mediaWanted(settings: MediaSettings): boolean {
  return Object.values(settings).some((value) => value === "auto");
}

export const legacyMediaSettings: MediaSettings = {
  recordings: "legacy",
  stills: "legacy",
  encode: "legacy",
  delivery: "legacy",
};
