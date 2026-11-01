import type { ProviderHeadroom } from "./usage-headroom.ts";
import { usableSessionLeft } from "./usage-headroom.ts";
import type { AccountLimits } from "./usage-limits.ts";

/*
 * The Usage page's suggestion under its Now line: when the account a provider starts new threads
 * on is short and another of its accounts has clearly more room, say so and offer to make that
 * one the default. The action is the existing account-default command; this only decides.
 */

export interface UsageSuggestion {
  provider: ProviderHeadroom["provider"];
  providerKey: string;
  /** The account to make the default. */
  account: AccountLimits;
  /** "Its Work account has a fresh session." */
  text: string;
  /** "Make Work the default for new Claude threads" */
  action: string;
}

/** The account for new threads must be under this share left to suggest another. */
const shortPercent = 50;
/** And the other must have at least this much more. */
const marginPercent = 25;

const shortNames: Partial<Record<string, string>> = { claude: "Claude", codex: "Codex" };

/**
 * The suggestion for `subject` (the provider the Now line names) if it has one, else for the
 * provider whose default is shortest against another account. Undefined when no account is
 * clearly better than the default.
 */
export function usageSuggestion(
  headroom: readonly ProviderHeadroom[],
  subject?: string,
): UsageSuggestion | undefined {
  const candidates = headroom.flatMap((entry) => {
    const current = entry.currentLeft;
    const best = entry.best;
    if (current === null || !best || best === entry.current) return [];
    const left = usableSessionLeft(best);
    if (left === null || current >= shortPercent || left - current < marginPercent) return [];
    return [{ entry, best, left, gap: left - current }];
  });
  const pick =
    candidates.find((candidate) => candidate.entry.key === subject) ??
    candidates.toSorted((a, b) => b.gap - a.gap)[0];
  if (!pick) return undefined;
  const { entry, best, left } = pick;
  const name = best.account.label;
  const owner = entry.key === subject ? "Its" : `${entry.providerLabel}'s`;
  const room = left >= 100 ? "a fresh session" : `${left}% of its session left`;
  const threads = shortNames[entry.provider] ?? entry.providerLabel;
  return {
    provider: entry.provider,
    providerKey: entry.key,
    account: best,
    text: `${owner} ${name} account has ${room}.`,
    action: `Make ${name} the default for new ${threads} threads`,
  };
}
