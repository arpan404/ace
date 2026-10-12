import type { AccountView, PickerModel, PickerProvider } from "@ace/ui-core";
import { accountLimit, providerNames } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";

export interface PickerEntry {
  id: string;
  provider?: ProviderKind | undefined;
  instance?: string | undefined;
  /** The ACP agent an account belongs to: each agent keeps its own rail tab and logo. */
  acpAgentId?: string | undefined;
  name: string;
  reason?: string | undefined;
}

/** The rail keeps every account, including empty and limited ones, default first. */
export function pickerEntries(
  providers: readonly PickerProvider[],
  models: readonly PickerModel[],
  accounts: readonly AccountView[],
  now: number,
  limitText: (at: number | undefined) => string,
): PickerEntry[] {
  return [
    { id: "favorites", name: "Favorites" },
    ...providers.flatMap((entry): PickerEntry[] => {
      const own = accounts
        .filter((account) => account.provider === entry.provider)
        .toSorted((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
      const listed = new Set(
        models
          .filter((model) => model.provider === entry.provider)
          .map((model) => model.instance)
          .filter((id) => id !== undefined),
      );
      const instances = [
        ...own.map((account) => account.id),
        ...[...listed].filter((id) => !own.some((candidate) => candidate.id === id)),
      ];
      if (!instances.length)
        return [
          {
            id: entry.provider,
            provider: entry.provider,
            name: providerNames[entry.provider],
            reason: entry.reason,
          },
        ];
      return instances.map((instance) => {
        const account = own.find((candidate) => candidate.id === instance);
        const limit = account && accountLimit(account, now);
        const name =
          account || instances.length > 1
            ? `${providerNames[entry.provider]} · ${account?.label ?? models.find((model) => model.instance === instance)?.source?.label ?? "Account"}`
            : providerNames[entry.provider];
        return {
          id: `${entry.provider}:${instance}`,
          provider: entry.provider,
          instance,
          acpAgentId: account?.acpAgentId,
          name,
          reason:
            limit?.level === "reached"
              ? limitText(limit.resetsAt)
              : account?.availability === "logged_out" &&
                  !models.some((model) => model.instance === instance)
                ? `Sign in to ${name}`
                : entry.reason,
        };
      });
    }),
  ];
}

/** One rail tab: Favorites, or a provider with its accounts (switched in the list header). */
export interface RailGroup {
  id: string;
  provider?: ProviderKind | undefined;
  /** "Claude Code" for several accounts; the account's own name for one. */
  name: string;
  /** Why none of its accounts can be picked from. */
  reason?: string | undefined;
  accounts: readonly PickerEntry[];
}

/**
 * The rail: one tab per provider rather than per account, so several accounts never stack up
 * as a column of near-identical logos. ACP agents are each their own tab, with their own logo.
 * A provider is usable while any of its accounts is.
 */
export function railGroups(entries: readonly PickerEntry[]): RailGroup[] {
  const groups: RailGroup[] = [];
  for (const entry of entries) {
    const key =
      entry.provider === "acp"
        ? `acp:${entry.acpAgentId ?? entry.instance ?? entry.id}`
        : (entry.provider ?? entry.id);
    const group = groups.find((candidate) => candidate.id === key);
    if (group) {
      const accounts = [...group.accounts, entry];
      groups[groups.indexOf(group)] = {
        ...group,
        name:
          entry.provider && entry.provider !== "acp" ? providerNames[entry.provider] : group.name,
        reason: accounts.every((account) => account.reason) ? group.reason : undefined,
        accounts,
      };
    } else
      groups.push({
        id: key,
        provider: entry.provider,
        name: entry.name,
        reason: entry.reason,
        accounts: [entry],
      });
  }
  return groups;
}
