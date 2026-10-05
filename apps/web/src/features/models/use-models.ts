import type { CatalogModel } from "@ace/protocol";
import {
  modelChoices,
  newThreadOptions,
  type AccountOption,
  type ModelChoice,
  type ModelOption,
} from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useAccountViews } from "@/features/accounts/index.ts";
import type { CatalogState } from "./control-view.ts";

/** Pages a large catalog in; the daemon returns at most 100 rows per `models.list`. */
const maxPages = 8;

/** The catalog as last read, and whether discovery was still refreshing any provider then. */
interface Catalog {
  models: CatalogModel[];
  refreshing: boolean;
}

/** Every model discovery found across the signed-in accounts (`models.list`). */
function useCatalogQuery() {
  return useDaemonQuery({
    queryKey: ["models", "list"],
    read: async (client, signal): Promise<Catalog> => {
      const models: CatalogModel[] = [];
      let refreshing = false;
      let offset: number | undefined = 0;
      for (let page = 0; page < maxPages && offset !== undefined; page++) {
        const start: number = offset;
        const reply = await client.request(
          { type: "models.list", options: { offset: start, limit: 100 } },
          { signal },
        );
        if (!("models" in reply.result)) break;
        models.push(...reply.result.models);
        refreshing ||= reply.result.instances.some((instance) => instance.refreshing);
        offset = reply.result.nextOffset;
      }
      return { models, refreshing };
    },
  });
}

/** Every model discovery found, or undefined until known (an error reads as empty). */
export function useModelCatalog(): CatalogModel[] | undefined {
  const query = useCatalogQuery();
  return query.data?.models ?? (query.isError ? none : undefined);
}

/**
 * Whether pickers have a list to show yet, and whether a newer one is on its way: being read
 * again, or still being discovered by the daemon.
 */
export function useModelCatalogState(): CatalogState {
  const query = useCatalogQuery();
  if (query.data === undefined) return query.isError ? "ready" : "loading";
  return query.isFetching || query.data.refreshing ? "refreshing" : "ready";
}

/** The list once known; an error reads as empty, so pickers fall back instead of waiting. */
function settled<T>(query: { data: T[] | undefined; isError: boolean }): T[] | undefined {
  return query.data ?? (query.isError ? none : undefined);
}
const none: never[] = [];

/** The composer's model picker: each model on the account that serves it, with its usage. */
export function useModelChoices(): readonly ModelChoice[] {
  const models = useModelCatalog();
  const accounts = settled(useAccountViews());
  return useMemo(() => modelChoices(models ?? [], accounts ?? []), [models, accounts]);
}

/**
 * New thread's model and account pickers over the installed providers, or undefined until the
 * catalog, the accounts and the providers have arrived.
 */
export function useNewThreadOptions():
  | { models: ModelOption[]; accounts: AccountOption[] }
  | undefined {
  const models = useModelCatalog();
  const accounts = settled(useAccountViews());
  const providers = settled(useProviderStatuses());
  return useMemo(
    () =>
      models && accounts && providers ? newThreadOptions(models, accounts, providers) : undefined,
    [models, accounts, providers],
  );
}
