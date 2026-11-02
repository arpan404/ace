import { accountProvider, type AccountRegistry } from "@ace/accounts";
import type { ProviderKind } from "@ace/protocol";

/** An account as `delegate` matches a name against it. */
export interface NamedAccount {
  id: string;
  label: string;
  provider: ProviderKind;
}

/** Every registered account, or none while account homes are still being validated. */
export function registeredAccounts(registry: AccountRegistry | undefined): NamedAccount[] {
  try {
    return (registry?.list() ?? []).map((entry) => ({
      id: entry.instance.id,
      label: entry.instance.label,
      provider: accountProvider(entry.instance),
    }));
  } catch {
    // The id is checked again at admission.
    return [];
  }
}

/** What a name matches: one account, none, or several sharing the label. */
export type NameMatch =
  | { account: NamedAccount }
  | { missing: true }
  | { shared: readonly NamedAccount[] };

/**
 * The accounts a name matches: an exact id first, else the accounts on `provider` (or on any
 * provider when none is named) whose label matches, ignoring case and outer spaces.
 */
export function matchAccountName(
  accounts: readonly NamedAccount[],
  provider: ProviderKind | undefined,
  name: string,
): NameMatch {
  const byId = accounts.find((entry) => entry.id === name);
  if (byId) return { account: byId };
  const wanted = name.trim().toLowerCase();
  const labelled = accounts.filter(
    (entry) =>
      entry.label.trim().toLowerCase() === wanted && (!provider || entry.provider === provider),
  );
  if (labelled.length > 1) return { shared: labelled };
  return labelled[0] ? { account: labelled[0] } : { missing: true };
}

/**
 * The account a name selects (see `matchAccountName`). A label two accounts share, or no match
 * at all, selects nothing.
 */
export function accountForName(
  accounts: readonly NamedAccount[],
  provider: ProviderKind | undefined,
  name: string,
): { id: string; provider: ProviderKind } | undefined {
  const match = matchAccountName(accounts, provider, name);
  return "account" in match
    ? { id: match.account.id, provider: match.account.provider }
    : undefined;
}
