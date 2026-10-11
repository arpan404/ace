import { useState } from "react";
import { PermissionClient } from "@ace/client";
import type {
  NativePermissionMode,
  PermissionCapabilities,
  PermissionMode,
  ProviderKind,
} from "@ace/protocol";
import { useDaemonQuery } from "./daemon-query.ts";
const emptyModes: NativePermissionMode[] = [];
/** Native catalog for new threads, or the live session catalog when available. */
export function usePermissionCapabilities(
  provider: ProviderKind | undefined,
  live?: PermissionCapabilities | undefined,
  instanceId?: string | undefined,
): { capabilities: PermissionCapabilities | undefined; loading: boolean; failed: boolean } {
  const query = useDaemonQuery({
    queryKey: ["permissions", "capabilities", provider, instanceId],
    enabled: !!provider && !live,
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

/** Keep requested native selections visible until the person replaces or resets them. */
export function usePermissionModes(
  provider: ProviderKind | undefined,
  options: {
    currentId?: PermissionMode | null | undefined;
    setCurrentId?: ((id: PermissionMode | null) => void) | undefined;
    live?: PermissionCapabilities | undefined;
    instanceId?: string | undefined;
  } = {},
) {
  const query = usePermissionCapabilities(provider, options.live, options.instanceId);
  const [choice, setChoice] = useState<PermissionMode | null>(null);
  const modes = query.capabilities?.permissionModes ?? emptyModes;
  // Catalog selections are opaque native IDs, even when they resemble old ace presets.
  // Deprecated stored settings are migrated by the settings boundary before reaching the UI.
  const currentId = options.currentId !== undefined ? options.currentId : choice;
  const setCurrentId = (id: PermissionMode | null) => {
    if (options.setCurrentId) options.setCurrentId(id);
    else setChoice(id);
  };
  return { ...query, modes, currentId, setCurrentId };
}
