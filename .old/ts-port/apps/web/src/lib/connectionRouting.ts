import type { ProjectId, ThreadId } from "@ace/contracts";

import { useHostConnectionStore } from "../hostConnectionStore";
import { normalizeWsUrl, resolveLocalDeviceWsUrl } from "./remoteHosts";

export const THREAD_ROUTE_CONNECTION_SEARCH_PARAM = "connection";
const RPC_ROUTE_CONNECTION_FIELD = "__aceRouteConnectionUrl";

export type RpcRouteConnectionInput = {
  readonly [RPC_ROUTE_CONNECTION_FIELD]?: string | null;
};

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

export function withRpcRouteConnection<T extends object>(
  input: T,
  connectionUrl: string | null | undefined,
): T & RpcRouteConnectionInput {
  if (!connectionUrl) {
    return input;
  }
  return {
    ...input,
    [RPC_ROUTE_CONNECTION_FIELD]: connectionUrl,
  };
}

export function stripRpcRouteConnection<T>(input: T): T {
  if (typeof input !== "object" || input === null || !(RPC_ROUTE_CONNECTION_FIELD in input)) {
    return input;
  }
  const { [RPC_ROUTE_CONNECTION_FIELD]: _connectionUrl, ...rest } = input as Record<
    string,
    unknown
  >;
  return rest as T;
}

export function resolveConnectionForInput(input: unknown): string {
  const routeConnectionUrl =
    readStringField(input, RPC_ROUTE_CONNECTION_FIELD) ?? readStringField(input, "connectionUrl");
  if (routeConnectionUrl) {
    return normalizeWsUrl(routeConnectionUrl);
  }
  const projectId = readStringField(input, "projectId") as ProjectId | undefined;
  const threadId = readStringField(input, "threadId") as ThreadId | undefined;
  if (threadId) {
    return (
      resolveConnectionForThreadId(threadId) ??
      (projectId ? resolveConnectionForProjectId(projectId) : undefined) ??
      readRouteConnectionUrlFromLocation() ??
      resolveLocalConnectionUrl()
    );
  }
  if (projectId) {
    return (
      resolveConnectionForProjectId(projectId) ??
      readRouteConnectionUrlFromLocation() ??
      resolveLocalConnectionUrl()
    );
  }
  return readRouteConnectionUrlFromLocation() ?? resolveLocalConnectionUrl();
}
