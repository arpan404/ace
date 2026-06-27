import { type ServerConfig, type ServerConfigStreamEvent } from "@ace/contracts";
import { useEffect, useState } from "react";

import { reportBackgroundError } from "../lib/async";
import { resolveLocalConnectionUrl } from "../lib/connectionRouting";
import { getRouteRpcClient } from "../lib/remoteWsRouter";
import { normalizeWsUrl } from "../lib/remoteHosts";
import { useServerConfig } from "../rpc/serverState";

const remoteServerConfigByConnectionUrl = new Map<string, ServerConfig>();

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
  projectConnectionUrl?: string | null;
  routeConnectionUrl?: string | null;
  threadConnectionUrl?: string | null;
}): string {
  const localConnectionUrl =
    normalizeConnectionUrl(input.localConnectionUrl) ?? resolveLocalConnectionUrl();
  const explicitConnectionUrl = normalizeConnectionUrl(input.explicitConnectionUrl);
  if (explicitConnectionUrl) {
    return explicitConnectionUrl;
  }

  const threadConnectionUrl = normalizeConnectionUrl(input.threadConnectionUrl);
  if (threadConnectionUrl) {
    return threadConnectionUrl;
  }

  const projectConnectionUrl = normalizeConnectionUrl(input.projectConnectionUrl);
  if (projectConnectionUrl) {
    return projectConnectionUrl;
  }

  return normalizeConnectionUrl(input.routeConnectionUrl) ?? localConnectionUrl;
}

export function applyConnectionServerConfigEvent(
  current: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  switch (event.type) {
    case "snapshot":
      return event.config;
    case "keybindingsUpdated":
      return current ? { ...current, issues: event.payload.issues } : current;
    case "providerStatuses":
      return current ? { ...current, providers: event.payload.providers } : current;
    case "settingsUpdated":
      return current ? { ...current, settings: event.payload.settings } : current;
    case "relayUpdated":
      return current ? { ...current, relay: event.payload.relay } : current;
  }
}

export function useConnectionServerConfig(
  connectionUrl: string | null | undefined,
): ServerConfig | null {
  const serverConfig = useServerConfig();
  const localConnectionUrl = resolveLocalConnectionUrl();
  const normalizedConnectionUrl = normalizeConnectionUrl(connectionUrl) ?? localConnectionUrl;
  const isLocalConnection = normalizedConnectionUrl === localConnectionUrl;
  const [remoteConfigState, setRemoteConfigState] = useState<{
    connectionUrl: string;
    config: ServerConfig | null;
  }>(() => ({
    connectionUrl: normalizedConnectionUrl,
    config: remoteServerConfigByConnectionUrl.get(normalizedConnectionUrl) ?? null,
  }));
  const remoteConfig =
    remoteConfigState.connectionUrl === normalizedConnectionUrl
      ? remoteConfigState.config
      : (remoteServerConfigByConnectionUrl.get(normalizedConnectionUrl) ?? null);

  useEffect(() => {
    if (isLocalConnection) {
      return;
    }

    let canceled = false;
    const client = getRouteRpcClient(normalizedConnectionUrl);
    const applyConfig = (config: ServerConfig) => {
      remoteServerConfigByConnectionUrl.set(normalizedConnectionUrl, config);
      if (!canceled) {
        setRemoteConfigState({ connectionUrl: normalizedConnectionUrl, config });
      }
    };

    const unsubscribe = client.server.subscribeConfig((event) => {
      const nextConfig = applyConnectionServerConfigEvent(
        remoteServerConfigByConnectionUrl.get(normalizedConnectionUrl) ?? null,
        event,
      );
      if (nextConfig) {
        applyConfig(nextConfig);
      }
    });

    void client.server
      .getConfig()
      .then((config) => {
        applyConfig(config);
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
  }, [isLocalConnection, normalizedConnectionUrl]);

  if (isLocalConnection) {
    return serverConfig;
  }

  return remoteConfig;
}
