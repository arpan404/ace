import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useMemo } from "react";
import type { StorageUsage, StorageRequest } from "@ace/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import {
  storageUsageGcMs,
  storageUsageKey,
  storageUsageStaleMs,
} from "@/lib/storage-usage-policy.ts";

async function readUsage(
  daemon: ClientApi,
  signal: AbortSignal,
  operation: Extract<StorageRequest["operation"], { op: "storage.usage" }>,
) {
  const reply = await daemon.request({ type: "storage.request", operation }, { signal });
  if (reply.result.kind === "error") throw new Error(reply.result.message);
  if (reply.result.kind !== "usage") throw new Error("Unexpected storage response.");
  return reply.result.usage;
}

function usageRefresher(client: ClientApi, cache: QueryClient) {
  let pending: Promise<StorageUsage> | undefined;
  return () => {
    pending ??= (async () => {
      // Cleanup may hold this callback across a reconnect. Read the live cache, not
      // a render's isFetching flag, and keep both reads bound to this client/cache.
      if (cache.getQueryState(storageUsageKey)?.fetchStatus === "fetching") {
        await cache
          .fetchQuery({
            queryKey: storageUsageKey,
            gcTime: storageUsageGcMs,
            staleTime: 0,
            retry: false,
            meta: { daemonClient: client },
            queryFn: ({ signal }) => readUsage(client, signal, { op: "storage.usage" }),
          })
          .catch(() => {});
      }
      return cache.fetchQuery({
        queryKey: storageUsageKey,
        gcTime: storageUsageGcMs,
        staleTime: 0,
        retry: false,
        meta: { daemonClient: client },
        queryFn: ({ signal }) => readUsage(client, signal, { op: "storage.usage", force: true }),
      });
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Cached daemon reads and explicit measurements update the same connection-scoped query. */
export function useStorageUsage() {
  const client = useClient();
  const cache = useQueryClient();
  const query = useDaemonQuery({
    queryKey: storageUsageKey,
    gcTime: storageUsageGcMs,
    staleTime: storageUsageStaleMs,
    read: (daemon, signal) => readUsage(daemon, signal, { op: "storage.usage" }),
  });
  const refresh = useMemo(() => usageRefresher(client, cache), [client, cache]);
  return { query, refresh };
}
