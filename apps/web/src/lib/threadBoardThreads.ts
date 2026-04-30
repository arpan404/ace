import type { ThreadId } from "@ace/contracts";

import { normalizeWsUrl, resolveLocalDeviceWsUrl } from "./remoteHosts";

export function normalizeThreadBoardConnectionUrl(
  connectionUrl: string | null | undefined,
): string | null {
  const normalized = connectionUrl?.trim();
  if (!normalized) {
    return null;
  }
  try {
    const normalizedWsUrl = normalizeWsUrl(normalized);
    if (
      typeof window !== "undefined" &&
      normalizedWsUrl === normalizeWsUrl(resolveLocalDeviceWsUrl())
    ) {
      return null;
    }
    return normalizedWsUrl;
  } catch {
    return normalized;
  }
}

export function buildThreadBoardThreadKey(
  threadId: ThreadId,
  connectionUrl: string | null | undefined,
): string {
  return `${normalizeThreadBoardConnectionUrl(connectionUrl) ?? "local"}:${threadId}`;
}
