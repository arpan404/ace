import type { ProjectId, ThreadId } from "@ace/contracts";

import { useHostConnectionStore } from "../hostConnectionStore";
import { normalizeWsUrl, resolveLocalDeviceWsUrl } from "./remoteHosts";

export const THREAD_ROUTE_CONNECTION_SEARCH_PARAM = "connection";

function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export function resolveLocalConnectionUrl(): string {
  return normalizeWsUrl(resolveLocalDeviceWsUrl());
}

export function readRouteConnectionUrlFromLocation(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const value = new URLSearchParams(window.location.search)
    .get(THREAD_ROUTE_CONNECTION_SEARCH_PARAM)
    ?.trim();
  if (!value) {
    return undefined;
  }
  try {
    return normalizeWsUrl(value);
  } catch {
    return undefined;
  }
}

export function resolveConnectionForThreadId(threadId: ThreadId): string | undefined {
  const mapped = useHostConnectionStore.getState().threadConnectionById[threadId];
  return mapped ? normalizeWsUrl(mapped) : undefined;
}

export function resolveConnectionForProjectId(projectId: ProjectId): string | undefined {
  const mapped = useHostConnectionStore.getState().projectConnectionById[projectId];
  return mapped ? normalizeWsUrl(mapped) : undefined;
}

export function resolveConnectionForInput(input: unknown): string {
  const threadId = readStringField(input, "threadId") as ThreadId | undefined;
  if (threadId) {
    return (
      resolveConnectionForThreadId(threadId) ??
      readRouteConnectionUrlFromLocation() ??
      resolveLocalConnectionUrl()
    );
  }
  const projectId = readStringField(input, "projectId") as ProjectId | undefined;
  if (projectId) {
    return (
      resolveConnectionForProjectId(projectId) ??
      readRouteConnectionUrlFromLocation() ??
      resolveLocalConnectionUrl()
    );
  }
  return readRouteConnectionUrlFromLocation() ?? resolveLocalConnectionUrl();
}
