import { accountShortLabel } from "@ace/accounts/labels";
import { liveWindow } from "@ace/accounts/availability";
import type { ProviderKind } from "@ace/protocol";
import type { AccountQuota, AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";
import type { ReadinessTone } from "./provider-readiness.ts";
import { providerDisplayName } from "./providers.ts";

type Summary = z.infer<typeof AccountSummary>;

/** One provider quota window, as a ring or meter shows it. */
export interface QuotaWindowView {
  id: string;
  label: string;
  usedPercent: number;
  /** Null when the provider didn't say when it resets. */
  resetsAt: number | null;
}
export interface AccountView {
  id: string;
  provider: ProviderKind;
  /** The ACP registry agent behind an `acp` account. */
  acpAgentId?: string | undefined;
  /** "Claude Code"; for an ACP agent, its registry name or id. */
  providerLabel: string;
  /** CLI version discovery reported, if any. */
  version: string | undefined;
  label: string;
  shortLabel?: string | undefined;
  badgeColor?: Summary["badgeColor"] | undefined;
  authMethod?: Summary["authMethod"] | undefined;
  signedInAs?: string | undefined;
  /** The CLI's own login (its normal home), not an account ace added. */
  implicit?: boolean | undefined;
  /** New threads on this provider start on it. */
  isDefault?: boolean | undefined;
  /** What the daemon said when it was read; `accountLimit` says what holds at a later moment. */
  availability: Summary["availability"];
  signedIn: boolean;
  /** Normal-profile runtime evidence when quota does not report authentication. */
  runtimeStatus?: { tone: ReadinessTone; text: string; canRun: boolean } | undefined;
  /** Shortest window first: 5-hour, then daily, weekly, then the rest by name. */
  windows: QuotaWindowView[];
  /** The quota as the daemon reported it, blockers included, for the shared availability rules. */
  quota: AccountQuota;
}

const known: [RegExp, string, number][] = [
  [/^(five_hour|5h|session)$|:primary$|^primary$/, "5-hour", 0],
  [/^(daily|one_day|day)$/, "Daily", 1],
  [/^(seven_day|weekly|week)$|:secondary$|^secondary$/, "Weekly", 2],
  [/^seven_day_opus$/, "Weekly Opus", 3],
  [/^seven_day_sonnet$/, "Weekly Sonnet", 3],
  [/^(monthly|month)$/, "Monthly", 4],
  [/^default$/, "Usage", 5],
];

function classify(name: string): { label: string; rank: number } {
  for (const [pattern, label, rank] of known) if (pattern.test(name)) return { label, rank };
  const words = name.replace(/[_:-]+/g, " ").trim();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), rank: 6 };
}

/** The provider's window id ("five_hour", "codex:secondary") in words ("5-hour", "Weekly"). */
export function quotaWindowLabel(name: string): string {
  return classify(name).label;
}

/** Account names stay exactly as entered. Normal-profile logins use only reported identity. */
export function accountDisplayName(
  account:
    | string
    | { label: string; implicit?: boolean | undefined; signedInAs?: string | undefined },
): string {
  if (typeof account === "string") return account;
  return account.implicit ? (account.signedInAs ?? "Your CLI login") : account.label;
}

/** What the accounts screen and pickers show for one `accounts.list` entry. */
export function accountView(summary: Summary): AccountView {
  const ranked: (QuotaWindowView & { rank: number })[] = [];
  for (const [id, window] of Object.entries(summary.quota.windows)) {
    const { label, rank } = classify(id);
    const usedPercent = Math.round(Math.min(100, Math.max(0, window.usedPercent)));
    ranked.push({ id, label, rank, usedPercent, resetsAt: window.resetsAt });
  }
  const windows = ranked
    .toSorted((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ rank: _rank, ...window }) => window);
  return {
    id: summary.id,
    provider: summary.provider,
    acpAgentId: summary.acpAgentId,
    providerLabel: providerDisplayName(summary.provider, summary.acpAgentId),
    version: summary.installationVersion,
    label: accountDisplayName(summary),
    shortLabel: accountShortLabel(summary),
    badgeColor: summary.badgeColor,
    authMethod: summary.authMethod,
    signedInAs: summary.signedInAs,
    ...(summary.implicit ? { implicit: true } : {}),
    ...(summary.isDefault ? { isDefault: true } : {}),
    availability: summary.availability,
    signedIn: summary.quota.auth === "logged_in" && summary.availability !== "logged_out",
    windows,
    quota: summary.quota,
  };
}

/** The window closest to its limit, which decides whether the account can take work. */
export function tightestWindow(account: {
  windows: readonly QuotaWindowView[];
}): QuotaWindowView | undefined {
  return account.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
}

/** The account's windows still in their period at `now`: one that has reset no longer counts. */
export function liveWindows(account: Pick<AccountView, "windows">, now: number): QuotaWindowView[] {
  return account.windows.filter((window) => liveWindow(window, now));
}
