import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { StorageRequest } from "@ace/protocol";
import { useQueryClient } from "@tanstack/react-query";
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
  const refresh = async () => {
    // A reconnect may already be reading the saved snapshot. Finish that read before forcing
    // measurement, rather than joining a cheap read and mistaking it for a completed scan.
    if (query.isFetching) await query.refetch({ cancelRefetch: false });
    return cache.fetchQuery({
      queryKey: storageUsageKey,
      gcTime: storageUsageGcMs,
      staleTime: 0,
      retry: false,
      meta: { daemonClient: client },
      queryFn: ({ signal }) => readUsage(client, signal, { op: "storage.usage", force: true }),
    });
  };
  return { query, refresh };
}
