import type { AccountQuota, QuotaWindow } from "@ace/protocol/accounts";

/*
 * What an account's quota means at a moment: whether it can take work, what holds it at its
 * limit and when that lets go, and which account automatic recovery moves a thread to. Pure and
 * portable (no Node built-ins): the daemon decides with it and the clients word the same facts
 * with it, so both always agree. Callers pass the clock.
 */

export type Availability = "available" | "near_limit" | "exhausted" | "logged_out" | "unknown";

/** From this share of a live window used, an account is near its limit. */
export const nearLimitPercent = 80;

/** A window still in its period at `now`: one whose reset has passed no longer counts. */
export function liveWindow(window: QuotaWindow, now: number): boolean {
  return window.resetsAt === null || window.resetsAt > now;
}

/**
 * Whether an account can take work at `now`. Unknown until the CLI says it is signed in; expired
 * windows and an expired limit error no longer hold it.
 */
export function availability(state: AccountQuota, now: number): Availability {
  if (state.blockers.homeUnavailable) return "unknown";
  if (state.auth === "logged_out") return "logged_out";
  if (state.auth !== "logged_in") return "unknown";
  if (state.blockers.overflow) return "exhausted";
  const fallback = state.blockers.limitError;
  if (fallback && liveWindow(fallback, now)) return "exhausted";
  let near = false;
  for (const window of Object.values(state.windows)) {
    if (!liveWindow(window, now)) continue;
    if (window.usedPercent >= 100) return "exhausted";
    if (window.usedPercent >= nearLimitPercent) near = true;
  }
  return near ? "near_limit" : "available";
}

/**
 * When an account held at its limit can work again: the last reset among what holds it (full
 * live windows and a live limit error), since every one must let go. Null when any of them has
 * no known reset or quota overflowed; undefined when nothing holds it.
 */
export function blockedUntil(state: AccountQuota, now: number): number | null | undefined {
  if (state.blockers.overflow) return null;
  let last: number | undefined;
  for (const window of [
    ...Object.values(state.windows),
    ...(state.blockers.limitError ? [state.blockers.limitError] : []),
  ]) {
    if (window.usedPercent < 100 || !liveWindow(window, now)) continue;
    if (window.resetsAt === null) return null;
    if (last === undefined || window.resetsAt > last) last = window.resetsAt;
  }
  return last;
}

/** The parts of an `accounts.list` entry automatic recovery picks a target from. */
export interface TargetCandidate {
  id: string;
  provider: string;
  quota: AccountQuota;
}

/**
 * Where automatic recovery moves a thread off account `from`: the first other account of the
 * same provider, in listed order, that is available at `now`.
 */
export function automaticTarget<T extends TargetCandidate>(
  accounts: readonly T[],
  from: { id: string; provider: string },
  now: number,
): T | undefined {
  return accounts.find(
    (account) =>
      account.id !== from.id &&
      account.provider === from.provider &&
      availability(account.quota, now) === "available",
  );
}
