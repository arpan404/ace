import type { ProviderKind } from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";
import { providerNames } from "./providers.ts";

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
  /** "Claude Code"; for an ACP agent, the agent's id. */
  providerLabel: string;
  /** CLI version discovery reported, if any. */
  version: string | undefined;
  label: string;
  availability: Summary["availability"];
  signedIn: boolean;
  /** Shortest window first: 5-hour, then daily, weekly, then the rest by name. */
  windows: QuotaWindowView[];
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

/** What the accounts screen and pickers show for one `accounts.list` entry. */
export function accountView(summary: Summary): AccountView {
  const windows = Object.entries(summary.quota.windows)
    .map(([id, window]) => ({ id, ...classify(id), ...window }))
    .toSorted((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ id, label, usedPercent, resetsAt }) => ({
      id,
      label,
      usedPercent: Math.round(Math.min(100, Math.max(0, usedPercent))),
      resetsAt,
    }));
  return {
    id: summary.id,
    provider: summary.provider,
    providerLabel:
      summary.provider === "acp" && summary.acpAgentId
        ? summary.acpAgentId
        : providerNames[summary.provider],
    version: summary.installationVersion,
    label: summary.label,
    availability: summary.availability,
    signedIn: summary.quota.auth !== "logged_out" && summary.availability !== "logged_out",
    windows,
  };
}

/** The window closest to its limit, which decides whether the account can take work. */
export function tightestWindow(account: AccountView): QuotaWindowView | undefined {
  return account.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
}

/** The earliest reset among exhausted windows: when the account can work again. */
export function blockingReset(account: AccountView): number | undefined {
  const resets = account.windows
    .filter((window) => window.usedPercent >= 100 && window.resetsAt !== null)
    .map((window) => window.resetsAt ?? 0);
  return resets.length ? Math.min(...resets) : undefined;
}
