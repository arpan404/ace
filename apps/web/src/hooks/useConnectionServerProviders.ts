import { type ProjectId, type ServerProvider, type ThreadId } from "@ace/contracts";
import { useEffect, useMemo, useState } from "react";

import { reportBackgroundError } from "../lib/async";
import { resolveLocalConnectionUrl } from "../lib/connectionRouting";
import { getRouteRpcClient } from "../lib/remoteWsRouter";
import { normalizeWsUrl } from "../lib/remoteHosts";
import { useServerProviders } from "../rpc/serverState";

const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const remoteProvidersByConnectionUrl = new Map<string, ReadonlyArray<ServerProvider>>();

function normalizeConnectionUrl(connectionUrl: string | null | undefined): string | null {
  const trimmed = connectionUrl?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return normalizeWsUrl(trimmed);
  } catch {
    return null;
  }
}

export function resolveThreadOriginConnectionUrl(input: {
  explicitConnectionUrl?: string | null;
  localConnectionUrl?: string;
  projectConnectionById: Readonly<Record<string, string>>;
  projectId?: ProjectId | null;
  routeConnectionUrl?: string | null;
  threadConnectionById: Readonly<Record<string, string>>;
  threadId: ThreadId;
}): string {
  const localConnectionUrl =
    normalizeConnectionUrl(input.localConnectionUrl) ?? resolveLocalConnectionUrl();
  const explicitConnectionUrl = normalizeConnectionUrl(input.explicitConnectionUrl);
  if (explicitConnectionUrl) {
    return explicitConnectionUrl;
  }

  const threadConnectionUrl = normalizeConnectionUrl(input.threadConnectionById[input.threadId]);
  if (threadConnectionUrl) {
    return threadConnectionUrl;
  }

  const projectConnectionUrl =
    input.projectId === null || input.projectId === undefined
      ? null
      : normalizeConnectionUrl(input.projectConnectionById[input.projectId]);
  if (projectConnectionUrl) {
    return projectConnectionUrl;
  }

  return normalizeConnectionUrl(input.routeConnectionUrl) ?? localConnectionUrl;
}

export function useConnectionServerProviders(
  connectionUrl: string | null | undefined,
  options?: { enabled?: boolean },
): ReadonlyArray<ServerProvider> {
  const enabled = options?.enabled ?? true;
  const localConnectionUrl = resolveLocalConnectionUrl();
  const normalizedConnectionUrl = useMemo(
    () => normalizeConnectionUrl(connectionUrl) ?? localConnectionUrl,
    [connectionUrl, localConnectionUrl],
  );
  const isLocalConnection = normalizedConnectionUrl === localConnectionUrl;
  const localProviders = useServerProviders({ enabled: enabled && isLocalConnection });
  const [remoteProviders, setRemoteProviders] = useState<ReadonlyArray<ServerProvider>>(
    remoteProvidersByConnectionUrl.get(normalizedConnectionUrl) ?? EMPTY_SERVER_PROVIDERS,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (isLocalConnection) {
      return;
    }
    setRemoteProviders(
      remoteProvidersByConnectionUrl.get(normalizedConnectionUrl) ?? EMPTY_SERVER_PROVIDERS,
    );

    let canceled = false;
    const client = getRouteRpcClient(normalizedConnectionUrl);
    const applyProviders = (providers: ReadonlyArray<ServerProvider>) => {
      remoteProvidersByConnectionUrl.set(normalizedConnectionUrl, providers);
      if (!canceled) {
        setRemoteProviders(providers);
      }
    };

    const unsubscribe = client.server.subscribeConfig((event) => {
      if (event.type === "snapshot") {
        applyProviders(event.config.providers);
        return;
      }
      if (event.type === "providerStatuses") {
        applyProviders(event.payload.providers);
      }
    });

    void client.server
      .getConfig()
      .then((config) => {
        applyProviders(config.providers);
      })
      .catch((error) => {
        reportBackgroundError(
          `Failed to read server config for connection '${normalizedConnectionUrl}'.`,
          error,
        );
      });

    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [enabled, isLocalConnection, normalizedConnectionUrl]);

  if (!enabled) {
    return EMPTY_SERVER_PROVIDERS;
  }

  if (isLocalConnection) {
    return localProviders;
  }

  return remoteProviders;
}
