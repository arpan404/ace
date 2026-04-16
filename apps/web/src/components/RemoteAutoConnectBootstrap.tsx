import { useEffect } from "react";
import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";

import {
  clearActiveWsUrlOverride,
  clearBootstrapWsUrlQueryParam,
  loadActiveWsUrlOverride,
} from "../lib/utils";
import {
  normalizeWsUrl,
  resolveLocalDeviceWsUrl,
  verifyWsHostConnection,
} from "../lib/remoteHosts";

export function shouldCleanupBootstrapQuery(search: string): boolean {
  return new URLSearchParams(search).has(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM);
}

export function shouldProbeActiveRemoteHost(input: {
  readonly activeWsOverride: string | undefined;
  readonly localDeviceWsUrl: string;
}): boolean {
  if (!input.activeWsOverride) {
    return false;
  }
  try {
    return normalizeWsUrl(input.activeWsOverride) !== normalizeWsUrl(input.localDeviceWsUrl);
  } catch {
    return false;
  }
}

interface RemoteAutoConnectBootstrapProps {
  readonly onSettled?: () => void;
}

export function RemoteAutoConnectBootstrap({ onSettled }: RemoteAutoConnectBootstrapProps) {
  useEffect(() => {
    const settle = () => {
      onSettled?.();
    };
    if (import.meta.env.MODE === "test") {
      settle();
      return;
    }
    let cancelled = false;
    const run = async () => {
      if (shouldCleanupBootstrapQuery(window.location.search)) {
        clearBootstrapWsUrlQueryParam();
      }
      const activeWsOverride = loadActiveWsUrlOverride();
      const localDeviceWsUrl = resolveLocalDeviceWsUrl();
      if (!shouldProbeActiveRemoteHost({ activeWsOverride, localDeviceWsUrl })) {
        settle();
        return;
      }
      if (!activeWsOverride) {
        settle();
        return;
      }

      try {
        await verifyWsHostConnection(activeWsOverride, { timeoutMs: 2_500 });
        if (!cancelled) {
          settle();
        }
      } catch {
        if (cancelled) {
          return;
        }
        clearActiveWsUrlOverride();
        settle();
        const nextUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.assign(nextUrl);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [onSettled]);

  return null;
}
