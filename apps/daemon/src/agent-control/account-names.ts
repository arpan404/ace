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

/**
 * The account a name selects: an exact id first, else the one account on `provider` (or on
 * any provider when none is named) whose label matches, ignoring case and outer spaces. A label
 * two accounts share, or no match at all, selects nothing.
 */
export function accountForName(
  accounts: readonly NamedAccount[],
  provider: ProviderKind | undefined,
  name: string,
): { id: string; provider: ProviderKind } | undefined {
  const byId = accounts.find((entry) => entry.id === name);
  if (byId) return { id: byId.id, provider: byId.provider };
  const wanted = name.trim().toLowerCase();
  const labelled = accounts.filter(
    (entry) =>
      entry.label.trim().toLowerCase() === wanted && (!provider || entry.provider === provider),
  );
  return labelled.length === 1 && labelled[0]
    ? { id: labelled[0].id, provider: labelled[0].provider }
    : undefined;
}
