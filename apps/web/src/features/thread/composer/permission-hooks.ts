import { PermissionClient } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { PermissionCapabilities, PermissionMode, ProviderKind } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/**
 * What a provider can gate in each permission mode (`permissions.capabilities`), for a thread
 * that doesn't exist yet or one whose live capabilities haven't arrived. `live` wins.
 */
export function usePermissionCapabilities(
  provider: ProviderKind | undefined,
  live?: PermissionCapabilities | undefined,
): { capabilities: PermissionCapabilities | undefined; loading: boolean; failed: boolean } {
  const query = useDaemonQuery({
    queryKey: ["permissions", "capabilities", provider],
    enabled: !!provider && !live,
    staleTime: 5 * 60_000,
    read: async (client, signal) => {
      if (!provider) return undefined;
      const reply = await new PermissionClient(client).getCapabilities(provider, undefined, {
        signal,
      });
      if (!reply.ok) throw new Error(reply.error ?? "unavailable");
      return reply.permissions;
    },
  });
  if (live) return { capabilities: live, loading: false, failed: false };
  return {
    capabilities: query.data,
    loading: !!provider && query.data === undefined && !query.isError,
    failed: query.isError,
  };
}

/** Set a thread's own mode, or `null` to follow the project and global default again. */
export function useSetThreadPermission(threadId: string) {
  const client = useClient();
  return async (mode: PermissionMode | null) => {
    const result = await new PermissionClient(client).setThread(threadId, mode);
    if (!result.ok) throw new Error(result.error ?? "refused");
  };
}
