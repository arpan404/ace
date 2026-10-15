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

/**
 * A reading older than this is shown with its age and never holds an account at its limit: the
 * provider may have reset it, sold more, or granted a reset since. Only a fresh reading, or the
 * provider refusing work again, says it is still limited. Codex is re-read well within this.
 */
export const staleReadingMs = 30 * 60_000;

/** A window still in its period at `now`: one whose reset has passed no longer counts. */
export function liveWindow(window: QuotaWindow, now: number): boolean {
  return window.resetsAt === null || window.resetsAt > now;
}

/** Whether a window was read recently enough at `now` to say anything about the account. */
export function freshReading(
  window: QuotaWindow,
  state: Pick<AccountQuota, "observedAt">,
  now: number,
): boolean {
  return now - (window.observedAt ?? state.observedAt) <= staleReadingMs;
}

/** The windows that say whether the account can work: a meter the provider shows never does. */
function limiting(state: AccountQuota): QuotaWindow[] {
  return Object.values(state.windows).filter((window) => !window.advisory);
}

/** What the provider definitely said holds the account at `now`: full, live and fresh. */
function holding(state: AccountQuota, now: number): QuotaWindow[] {
  return [
    ...limiting(state),
    ...(state.blockers.limitError ? [state.blockers.limitError] : []),
  ].filter(
    (window) =>
      window.usedPercent >= 100 && liveWindow(window, now) && freshReading(window, state, now),
  );
}

/**
 * Whether an account can take work at `now`. Unknown until the CLI says it is signed in. Only a
 * definite provider signal holds it: a fresh window at 100% or the provider's own usage-limit
 * code. Expired, stale or unreadable (overflowed) readings never do: an unknown limit is not one.
 */
export function availability(state: AccountQuota, now: number): Availability {
  if (state.blockers.homeUnavailable) return "unknown";
  if (state.auth === "logged_out") return "logged_out";
  if (state.auth !== "logged_in") return "unknown";
  if (holding(state, now).length) return "exhausted";
  for (const window of limiting(state))
    if (
      window.usedPercent >= nearLimitPercent &&
      liveWindow(window, now) &&
      freshReading(window, state, now)
    )
      return "near_limit";
  return "available";
}

/**
 * Whether the account has a fresh reading at `now` that shows it below its limit: nothing holds
 * it and at least one window was just read. This, not the mere absence of a limit, is what lets
 * a thread held at a limit carry on.
 */
export function freshlyBelowLimit(state: AccountQuota, now: number): boolean {
  const level = availability(state, now);
  return (
    (level === "available" || level === "near_limit") &&
    limiting(state).some((window) => liveWindow(window, now) && freshReading(window, state, now))
  );
}

/**
 * When an account held at its limit can work again: the last reset among what holds it that says
 * when, since every one must let go. A holder without a reset (a usage-limit error whose words
 * gave no time) is explained by the full windows beside it, and is never guessed past. Null
 * when nothing holding it says when; undefined when nothing holds it.
 */
export function blockedUntil(state: AccountQuota, now: number): number | null | undefined {
  let last: number | undefined;
  let held = false;
  for (const window of holding(state, now)) {
    held = true;
    if (window.resetsAt !== null && (last === undefined || window.resetsAt > last))
      last = window.resetsAt;
  }
  return held ? (last ?? null) : undefined;
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
