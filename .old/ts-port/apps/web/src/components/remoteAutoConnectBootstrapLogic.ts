import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";

import { normalizeWsUrl } from "../lib/remoteHosts";

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
