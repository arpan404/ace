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
import { useAccountViews } from "@/features/accounts/index.ts";

/** Pages a large catalog in; the daemon returns at most 100 rows per `models.list`. */
const maxPages = 8;

/** Every model discovery found across the signed-in accounts (`models.list`). */
export function useModelCatalog() {
  return useDaemonQuery({
    queryKey: ["models", "list"],
    read: async (client, signal): Promise<CatalogModel[]> => {
      const models: CatalogModel[] = [];
      let offset: number | undefined = 0;
      for (let page = 0; page < maxPages && offset !== undefined; page++) {
        const start: number = offset;
        const reply = await client.request(
          { type: "models.list", options: { offset: start, limit: 100 } },
          { signal },
        );
        if (!("models" in reply.result)) break;
        models.push(...reply.result.models);
        offset = reply.result.nextOffset;
      }
      return models;
    },
  });
}

/** The list once known; an error reads as empty, so pickers fall back instead of waiting. */
function settled<T>(query: { data: T[] | undefined; isError: boolean }): T[] | undefined {
  return query.data ?? (query.isError ? none : undefined);
}
const none: never[] = [];

/** The composer's model picker: each model on the account that serves it, with its usage. */
export function useModelChoices(): readonly ModelChoice[] {
  const models = settled(useModelCatalog());
  const accounts = settled(useAccountViews());
  return useMemo(() => modelChoices(models ?? [], accounts ?? []), [models, accounts]);
}

/** New thread's model and account pickers, or undefined until both lists have arrived. */
export function useNewThreadOptions():
  | { models: ModelOption[]; accounts: AccountOption[] }
  | undefined {
  const models = settled(useModelCatalog());
  const accounts = settled(useAccountViews());
  return useMemo(
    () => (models && accounts ? newThreadOptions(models, accounts) : undefined),
    [models, accounts],
  );
}
