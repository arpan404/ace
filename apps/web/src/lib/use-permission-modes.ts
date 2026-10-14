import { PermissionClient } from "@ace/client";
import type { AccessModeOffer, NativePermissionMode, ProviderKind } from "@ace/protocol";
import { useDaemonQuery } from "./daemon-query.ts";

const none: AccessModeOffer[] = [];
const noNative: NativePermissionMode[] = [];

function useCapabilitiesReply(
  provider: ProviderKind | undefined,
  instanceId: string | undefined,
  enabled: boolean,
) {
  return useDaemonQuery({
    queryKey: ["permissions", "capabilities", provider, instanceId],
    enabled: !!provider && enabled,
    staleTime: 5 * 60_000,
    read: async (client, signal) => {
      if (!provider) return undefined;
      const reply = await new PermissionClient(client).getCapabilities(
        provider,
        undefined,
        { signal },
        instanceId,
      );
      if (!reply.ok) throw new Error(reply.error ?? "unavailable");
      return {
        accessModes: reply.accessModes ?? none,
        native: reply.permissions?.permissionModes ?? noNative,
      };
    },
  });
}

/**
 * The ace access modes a provider genuinely supports: a live thread's own report when given,
 * else the daemon's for a new thread on that provider and account.
 */
export function useAccessModes(
  provider: ProviderKind | undefined,
  live?: readonly AccessModeOffer[] | undefined,
  instanceId?: string | undefined,
): { offers: readonly AccessModeOffer[]; loading: boolean; failed: boolean } {
  const query = useCapabilitiesReply(provider, instanceId, !live);
  if (live) return { offers: live, loading: false, failed: false };
  return {
    offers: query.data?.accessModes ?? none,
    loading: !!provider && query.data === undefined && !query.isError,
    failed: query.isError,
  };
}

/** A provider's native modes, offered only under Settings → Providers → Advanced. */
export function useNativeModes(provider: ProviderKind | undefined) {
  const query = useCapabilitiesReply(provider, undefined, true);
  return {
    modes: query.data?.native ?? noNative,
    loading: !!provider && query.data === undefined && !query.isError,
  };
}
