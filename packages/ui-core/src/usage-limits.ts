import type { ProviderKind } from "@ace/protocol";
import { liveWindows, type AccountView } from "./accounts.ts";
import { formatCountdown } from "./time.ts";

/*
 * The Usage page's limits, account first: each provider's accounts, each listed once with its
 * windows beneath it. Every figure is what is LEFT (100 − used), so it never reads two ways.
 */

/** An account as the Usage page lists it, with the environment (daemon) that reported it. */
export interface UsageAccount {
  account: AccountView;
  environment: string;
}

/** How a window's use compares with the time it has run. */
export type LimitPace = "ahead" | "on_pace" | "behind";

/** One of an account's windows. */
export interface AccountWindow {
  id: string;
  /** "5-hour", "Weekly", "Weekly · GPT-5.3-Codex-Spark". */
  label: string;
  leftPercent: number;
  resetsAt: number | null;
  pace: LimitPace | undefined;
}

export interface AccountLimits {
  key: string;
  account: AccountView;
  environment: string;
  /** Banked resets the provider reports; undefined when it doesn't report them. */
  bankedResets: number | undefined;
  bankedExpiresAt: number | null;
  /** Shortest window first, as the account lists them. */
  windows: AccountWindow[];
}

export interface ProviderLimits {
  key: string;
  provider: ProviderKind;
  acpAgentId: string | undefined;
  providerLabel: string;
  accounts: AccountLimits[];
}

export interface UsageLimits {
  providers: ProviderLimits[];
  /** Providers with accounts but no live limits, by name: one quiet line. */
  quiet: string[];
}

const minute = 60_000;

/** "62% left" from a used share; never below 0 or above 100. */
export function leftPercent(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/** "4h 59m", "6d 12h": the time until a reset. Null when not reported. */
export function resetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  return formatCountdown(resetsAt - now);
}

/**
 * Whether a window is being used faster than it runs: `ahead` when the used share leads the
 * elapsed share by more than a tenth, `behind` when it trails by as much. Needs the window's
 * length and reset time; otherwise undefined.
 */
export function limitPace(
  usedPercent: number,
  resetsAt: number | null,
  durationMins: number | undefined,
  now: number,
): LimitPace | undefined {
  if (resetsAt === null || durationMins === undefined || durationMins <= 0) return undefined;
  const length = durationMins * minute;
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / length));
  const used = usedPercent / 100;
  if (used - elapsed > 0.1) return "ahead";
  if (elapsed - used > 0.1) return "behind";
  return "on_pace";
}

/**
 * Group accounts with live windows by provider, in the order they first appear. A provider whose
 * accounts report no live window joins the quiet line instead.
 */
export function usageLimits(accounts: readonly UsageAccount[], now: number): UsageLimits {
  const groups = new Map<string, ProviderLimits>();
  const silent = new Map<string, string>();
  for (const { account, environment } of accounts) {
    const key = `${account.provider}:${account.acpAgentId ?? ""}`;
    const windows = liveWindows(account, now);
    if (!windows.length) {
      if (!groups.has(key)) silent.set(key, account.providerLabel);
      continue;
    }
    silent.delete(key);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        provider: account.provider,
        acpAgentId: account.acpAgentId,
        providerLabel: account.providerLabel,
        accounts: [],
      };
      groups.set(key, group);
    }
    group.accounts.push({
      key: `${environment}\0${account.id}`,
      account,
      environment,
      bankedResets: account.resetCredits?.available,
      bankedExpiresAt: account.resetCredits?.nextExpiresAt ?? null,
      windows: windows.map((window) => ({
        id: window.id,
        label: window.label,
        leftPercent: leftPercent(window.usedPercent),
        resetsAt: window.resetsAt,
        pace: limitPace(window.usedPercent, window.resetsAt, window.windowDurationMins, now),
      })),
    });
  }
  return { providers: [...groups.values()], quiet: [...new Set(silent.values())] };
}
