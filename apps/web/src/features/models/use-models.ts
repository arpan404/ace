import type { CatalogModel } from "@ace/protocol";
import {
  modelChoices,
  newThreadOptions,
  type AccountOption,
  type ModelChoice,
  type ModelOption,
} from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useProviderStatuses } from "@/lib/provider-statuses.ts";
import { useNow } from "@/lib/time.ts";
import { useAccountViews } from "@/features/accounts/index.ts";
import type { CatalogState } from "./control-view.ts";

/** Pages a large catalog in; the daemon returns at most 100 rows per `models.list`. */
const maxPages = 8;

/**
 * The catalog as last read. `refreshing` is set while the daemon was still discovering some
 * provider's models when it answered; `polls` counts the reads in a row that found it so.
 */
interface Catalog {
  models: CatalogModel[];
  refreshing: boolean;
  polls: number;
}

const catalogKey = ["models", "list"] as const;

/**
 * Discovery runs in the daemon after `models.list` has answered, and no event says it ended:
 * while a read finds it refreshing, read again, 750 ms after the first and doubling to 8 s.
 * After `maxPolls` reads in a row the list is shown as it stands, without the spinner, and
 * the next ordinary refetch looks again. Reads stop as soon as discovery settles, on unmount,
 * and (TanStack Query's default) while the window is in the background.
 */
const firstPollMs = 750;
const lastPollMs = 8_000;
const maxPolls = 10;
const pollDelay = (polls: number) => Math.min(lastPollMs, firstPollMs * 2 ** polls);
const polling = (catalog: Catalog | undefined) =>
  catalog !== undefined && catalog.refreshing && catalog.polls < maxPolls;

/** Every model discovery found across the signed-in accounts (`models.list`). */
function useCatalogQuery() {
  const queryClient = useQueryClient();
  return useDaemonQuery<Catalog>({
    queryKey: catalogKey,
    refetchInterval: (query) => {
      const catalog = query.state.data;
      return catalog && polling(catalog) ? pollDelay(catalog.polls) : false;
    },
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
      const previous = queryClient.getQueryData<Catalog>(catalogKey);
      const polls = refreshing && previous?.refreshing ? previous.polls + 1 : 0;
      return { models, refreshing, polls };
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
  return query.isFetching || polling(query.data) ? "refreshing" : "ready";
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
  const models = useModelCatalog();
  const accounts = settled(useAccountViews());
  const providers = settled(useProviderStatuses());
  return useMemo(
    () =>
      models && accounts && providers ? newThreadOptions(models, accounts, providers) : undefined,
    [models, accounts, providers],
  );
}
