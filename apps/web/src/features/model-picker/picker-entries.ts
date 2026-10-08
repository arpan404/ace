import type { AccountView, PickerModel, PickerProvider } from "@ace/ui-core";
import { accountLimit, providerNames } from "@ace/ui-core";
import type { ProviderKind } from "@ace/protocol";

export interface PickerEntry {
  id: string;
  provider?: ProviderKind | undefined;
  instance?: string | undefined;
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
          own.length > 1
            ? `${providerNames[entry.provider]} · ${account?.label ?? models.find((model) => model.instance === instance)?.source?.label ?? "Account"}`
            : providerNames[entry.provider];
        return {
          id: `${entry.provider}:${instance}`,
          provider: entry.provider,
          instance,
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
