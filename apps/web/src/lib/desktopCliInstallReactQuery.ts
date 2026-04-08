import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopCliInstallState } from "@ace/contracts";

export const desktopCliInstallQueryKeys = {
  all: ["desktop", "cli-install"] as const,
  state: () => ["desktop", "cli-install", "state"] as const,
};

export const setDesktopCliInstallStateQueryData = (
  queryClient: QueryClient,
  state: DesktopCliInstallState | null,
) => queryClient.setQueryData(desktopCliInstallQueryKeys.state(), state);

export function desktopCliInstallStateQueryOptions() {
  return queryOptions({
    queryKey: desktopCliInstallQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getCliInstallState !== "function") {
        return null;
      }
      return bridge.getCliInstallState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopCliInstallState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopCliInstallStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onCliInstallState !== "function") {
      return;
    }

    return bridge.onCliInstallState((nextState) => {
      setDesktopCliInstallStateQueryData(queryClient, nextState);
    });
  }, [queryClient]);

  return query;
}
