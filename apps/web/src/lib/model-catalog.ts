import { withoutEmptySources } from "@ace/ui-core";
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { CatalogModel, ModelFilter, ModelInstanceStatus } from "@ace/protocol";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/*
 * The model catalog alone (`models.list`), apart from the pickers that join it with accounts and
 * providers: a thread's composer reads what its model takes from it without loading those.
 */

/**
 * Where the model list stands: still arriving (the picker shows placeholder rows), being
 * discovered again with the last list shown meanwhile, or settled.
 */
export type CatalogState = "loading" | "refreshing" | "ready";

/** Every model row, and each account's (instance's) freshness and discovery errors. */
export interface Catalog {
  models: CatalogModel[];
  instances: ModelInstanceStatus[];
}

/** Pages a large catalog in; the daemon returns at most 100 rows per `models.list`. */
const maxPages = 8;

export const catalogKey = ["models", "list"] as const;

const scopeOf = (row: { provider: string; instance: string }) =>
  `${row.provider}\u0000${row.instance}`;

/** Every page of `models.list` for `filter` (the whole catalog when empty). */
async function readCatalog(
  client: ClientApi,
  filter: ModelFilter,
  signal?: AbortSignal,
): Promise<Catalog> {
  const models: CatalogModel[] = [];
  const instances = new Map<string, ModelInstanceStatus>();
  let offset: number | undefined = 0;
  for (let page = 0; page < maxPages && offset !== undefined; page++) {
    const start: number = offset;
    const reply = await client.request(
      { type: "models.list", options: { ...filter, offset: start, limit: 100 } },
      signal ? { signal } : {},
    );
    if (!("models" in reply.result)) throw new Error("Model discovery is unavailable");
    models.push(...reply.result.models);
    for (const status of reply.result.instances) instances.set(scopeOf(status), status);
    offset = reply.result.nextOffset;
  }
  const statuses = [...instances.values()];
  return { models: withoutEmptySources(models, statuses), instances: statuses };
}

/** `rows` with one account's rows replaced by `next`, where the old ones stood. */
function splice<T extends { provider: string; instance: string }>(
  rows: readonly T[],
  scope: string,
  next: readonly T[],
): T[] {
  const at = rows.findIndex((row) => scopeOf(row) === scope);
  const kept = rows.filter((row) => scopeOf(row) !== scope);
  const index = at < 0 ? kept.length : at;
  return [...kept.slice(0, index), ...next, ...kept.slice(index)];
}

/**
 * The daemon says when a catalog changes (`models.changed`, for one provider and account) rather
 * than sending it. Bursts (a refresh starts and ends for every account) are gathered for a
 * moment, then each account named is read again and put in place; several at once, or one
 * arriving while the whole list is being read, read the whole list again. So does every
 * reconnect, since pushes may have been missed. One watcher per client, while anything reads
 * the catalog.
 */
const gatherMs = 60;
const watchers = new WeakMap<ClientApi, { users: number; stop(): void }>();

function watchCatalog(client: ClientApi, queryClient: QueryClient): () => void {
  let watcher = watchers.get(client);
  if (!watcher) {
    const changed = new Map<string, ModelFilter>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readAll = () => void queryClient.invalidateQueries({ queryKey: catalogKey });
    const flush = async () => {
      timer = undefined;
      const filters = [...changed.values()];
      changed.clear();
      const fetching = queryClient.getQueryState(catalogKey)?.fetchStatus === "fetching";
      if (fetching) {
        await queryClient.cancelQueries({ queryKey: catalogKey });
        return readAll();
      }
      if (
        !queryClient.getQueryData(catalogKey) ||
        filters.length > 3 ||
        filters.some((filter) => !filter.instance)
      )
        return readAll();
      for (const filter of filters) {
        const scope = scopeOf({ provider: filter.provider ?? "", instance: filter.instance ?? "" });
        try {
          const fresh = await readCatalog(client, filter);
          queryClient.setQueryData<Catalog>(
            catalogKey,
            (catalog) =>
              catalog && {
                models: splice(catalog.models, scope, fresh.models),
                instances: splice(catalog.instances, scope, fresh.instances),
              },
          );
        } catch {
          return readAll();
        }
      }
    };
    const connection = client.connectionState();
    let ready = connection.getSnapshot() === "ready";
    const stops = [
      client.onMessage((message) => {
        if (message.type !== "models.changed") return;
        const { provider, instance } = message.filter;
        changed.set(scopeOf({ provider: provider ?? "", instance: instance ?? "" }), {
          provider,
          instance,
        });
        timer ??= setTimeout(() => void flush(), gatherMs);
      }),
      connection.subscribe(() => {
        const now = connection.getSnapshot() === "ready";
        if (now && !ready && queryClient.getQueryData(catalogKey)) readAll();
        ready = now;
      }),
    ];
    const created = {
      users: 0,
      stop() {
        for (const stop of stops) stop();
        if (timer) clearTimeout(timer);
        watchers.delete(client);
      },
    };
    watchers.set(client, created);
    watcher = created;
  }
  const active = watcher;
  active.users++;
  return () => {
    if (--active.users === 0) active.stop();
  };
}

/** Every model discovery found across the signed-in accounts (`models.list`), kept current. */
export function useCatalogQuery() {
  const client = useClient();
  const queryClient = useQueryClient();
  useEffect(() => watchCatalog(client, queryClient), [client, queryClient]);
  return useDaemonQuery<Catalog>({
    queryKey: catalogKey,
    read: (reader, signal) => readCatalog(reader, {}, signal),
  });
}

/** Every model discovery found, or undefined until discovery is known. */
export function useModelCatalog(): CatalogModel[] | undefined {
  const query = useCatalogQuery();
  return query.data?.models ?? (query.isError ? noModels : undefined);
}

/** Each account's freshness, last refresh and discovery errors; empty until known. */
export function useModelInstances(): readonly ModelInstanceStatus[] {
  return useCatalogQuery().data?.instances ?? noInstances;
}

/**
 * Whether pickers have a list to show yet, and whether a newer one is on its way: being read
 * again, or still being discovered by the daemon.
 */
export function useModelCatalogState(): CatalogState {
  const query = useCatalogQuery();
  if (query.data === undefined) return query.isError ? "ready" : "loading";
  const discovering = query.data.instances.some(
    (status) => status.status === "refreshing" || status.refreshing,
  );
  return query.isFetching || discovering ? "refreshing" : "ready";
}

const noModels: CatalogModel[] = [];
const noInstances: ModelInstanceStatus[] = [];
