import {
  modelChoices,
  newThreadOptions,
  type AccountOption,
  type ModelChoice,
  type ModelOption,
} from "@ace/ui-core";
import { useMemo } from "react";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useNow } from "@/lib/time.ts";
import { useAccountViews } from "@/features/accounts/index.ts";
import { useCatalogQuery, useModelCatalog } from "@/lib/model-catalog.ts";

/** The list once known; an error reads as empty, so pickers fall back instead of waiting. */
function settled<T>(query: { data: T[] | undefined; isError: boolean }): T[] | undefined {
  return query.data ?? (query.isError ? none : undefined);
}
const none: never[] = [];

/** The composer's model picker: each model on the account that serves it, with its usage. */
export function useModelChoices(): readonly ModelChoice[] {
  const models = useModelCatalog();
  const accounts = settled(useAccountViews());
  const now = useNow();
  return useMemo(() => modelChoices(models ?? [], accounts ?? [], now), [models, accounts, now]);
}

/**
 * New thread's model and account pickers over the installed providers, or undefined until the
 * catalog, the accounts and the providers have arrived.
 */
export function useNewThreadOptions():
  | { models: ModelOption[]; accounts: AccountOption[] }
  | undefined {
  const catalog = useCatalogQuery();
  const models = catalog.data?.models ?? (catalog.isError ? none : undefined);
  const accounts = settled(useAccountViews());
  const providers = settled(useProviderStatuses());
  return useMemo(
    () =>
      models && accounts && providers ? newThreadOptions(models, accounts, providers) : undefined,
    [models, accounts, providers],
  );
}
