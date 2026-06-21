import { useEffect } from "react";

import {
  clearActiveWsUrlOverride,
  clearBootstrapWsUrlQueryParam,
  loadActiveWsUrlOverride,
} from "../lib/utils";
import { resolveLocalDeviceWsUrl, verifyWsHostConnection } from "../lib/remoteHosts";
import {
  shouldCleanupBootstrapQuery,
  shouldProbeActiveRemoteHost,
} from "./remoteAutoConnectBootstrapLogic";

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
