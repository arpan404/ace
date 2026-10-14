import type { ProviderKind } from "@ace/protocol";
import { liveWindows, type AccountView } from "./accounts.ts";
import { formatCountdown } from "./time.ts";

/*
 * The Usage page's limits: each provider's windows as rows, each row one segment per account.
 * Everything is phrased as what is LEFT (100 − used), so a figure never reads two ways.
 */

/** An account as the Usage page lists it, with the environment (daemon) that reported it. */
export interface UsageAccount {
  account: AccountView;
  /** The environment's name, when more than one environment is shown. */
  environment?: string | undefined;
}

/** How a window's use compares with the time it has run. */
export type LimitPace = "ahead" | "on_pace" | "behind";

/** One account's share of a window row. */
export interface LimitSegment {
  accountId: string;
  /**
   * The account's name ("Personal"), with its environment ("Personal · Build server") when the
   * provider's accounts come from more than one environment.
   */
  label: string;
  environment?: string | undefined;
  account: AccountView;
  leftPercent: number;
  resetsAt: number | null;
  /** Banked resets the provider reports for the account; undefined when it doesn't report them. */
  bankedResets: number | undefined;
  bankedExpiresAt: number | null;
}

/** One window kind ("5-hour", "Weekly", "Weekly · GPT-5.3-Codex-Spark") across a provider's accounts. */
export interface LimitRow {
  label: string;
  /** Mean of the segments' remaining shares: the bar's overall fill. */
  leftPercent: number;
  /** The soonest reset among the segments. */
  resetsAt: number | null;
  pace: LimitPace | undefined;
  segments: LimitSegment[];
}

export interface ProviderLimitGroup {
  key: string;
  provider: ProviderKind;
  acpAgentId: string | undefined;
  providerLabel: string;
  rows: LimitRow[];
}

export interface UsageLimits {
  providers: ProviderLimitGroup[];
  /** Providers with accounts but no live limits, by name: one quiet line. */
  quiet: string[];
}

const minute = 60_000;

/** "62% left" from a used share; never below 0 or above 100. */
export function leftPercent(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/** "4h 59m", "6d 12h": the time until a reset, for the reset chip. Null when not reported. */
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

const order = (label: string) =>
  label.startsWith("5-hour") || /^\d+-hour/.test(label)
    ? 0
    : label.startsWith("Daily")
      ? 1
      : label.startsWith("Weekly")
        ? 2
        : label.startsWith("Monthly")
          ? 3
          : 4;

/**
 * Group accounts' live windows by provider and window kind. Providers keep the order they first
 * appear in; rows run shortest window first; segments keep the accounts' order.
 */
export function usageLimits(accounts: readonly UsageAccount[], now: number): UsageLimits {
  const groups = new Map<string, ProviderLimitGroup & { byLabel: Map<string, LimitRow> }>();
  const silent = new Map<string, string>();
  const durations = new Map<LimitRow, number | undefined>();
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
        rows: [],
        byLabel: new Map(),
      };
      groups.set(key, group);
    }
    for (const window of windows) {
      let row = group.byLabel.get(window.label);
      if (!row) {
        row = {
          label: window.label,
          leftPercent: 0,
          resetsAt: null,
          pace: undefined,
          segments: [],
        };
        group.byLabel.set(window.label, row);
        group.rows.push(row);
      }
      if (!durations.has(row)) durations.set(row, window.windowDurationMins);
      row.segments.push({
        accountId: account.id,
        label: account.label,
        environment,
        account,
        leftPercent: leftPercent(window.usedPercent),
        resetsAt: window.resetsAt,
        bankedResets: account.resetCredits?.available,
        bankedExpiresAt: account.resetCredits?.nextExpiresAt ?? null,
      });
    }
  }
  const providers = [...groups.values()].map((group): ProviderLimitGroup => {
    const places = new Set(group.rows.flatMap((row) => row.segments.map((s) => s.environment)));
    return {
      key: group.key,
      provider: group.provider,
      acpAgentId: group.acpAgentId,
      providerLabel: group.providerLabel,
      rows: group.rows
        .map((row) => {
          if (places.size > 1)
            for (const segment of row.segments)
              if (segment.environment) segment.label = `${segment.label} · ${segment.environment}`;
          const left =
            row.segments.reduce((sum, segment) => sum + segment.leftPercent, 0) /
            row.segments.length;
          const resets = row.segments
            .map((segment) => segment.resetsAt)
            .filter((at): at is number => at !== null);
          const resetsAt = resets.length ? Math.min(...resets) : null;
          return {
            ...row,
            leftPercent: Math.round(left),
            resetsAt,
            pace: limitPace(100 - left, resetsAt, durations.get(row), now),
          };
        })
        .toSorted((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label)),
    };
  });
  return { providers, quiet: [...new Set(silent.values())] };
}
