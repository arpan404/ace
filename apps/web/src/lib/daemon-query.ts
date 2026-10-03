import type { Client } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  useQuery,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

type Options<T> = Omit<UseQueryOptions<T, Error, T, QueryKey>, "queryFn" | "enabled"> & {
  enabled?: boolean;
};

/**
 * A one-off daemon read (`Client.request`) through TanStack Query. It waits for a ready
 * connection, since requests never queue while offline, and runs again after a reconnect, so a
 * page opened during a daemon restart fills in once the daemon is back.
 */
export function useDaemonQuery<T>(
  options: Options<T> & { read(client: Client, signal: AbortSignal): Promise<T> },
): UseQueryResult<T, Error> {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const { read, enabled, ...rest } = options;
  return useQuery({
    ...rest,
    queryFn: ({ signal }) => read(client, signal),
    enabled: ready && (enabled ?? true),
  });
}
