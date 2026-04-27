import { ThreadId } from "@ace/contracts";

import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "./connectionRouting";
import { normalizeWsUrl, resolveLocalDeviceWsUrl } from "./remoteHosts";

export const THREAD_BOARD_THREADS_SEARCH_PARAM = "threads";
export const THREAD_BOARD_ACTIVE_SEARCH_PARAM = "active";
export const THREAD_BOARD_SPLIT_SEARCH_PARAM = "split";

const THREAD_BOARD_PANE_SEPARATOR = "___";
const THREAD_BOARD_CONNECTION_SEPARATOR = "|";

export interface ChatThreadBoardRoutePane {
  connectionUrl: string | null;
  threadId: ThreadId;
}

function normalizeConnectionUrl(connectionUrl: string | null | undefined): string | null {
  const normalized = connectionUrl?.trim();
  return normalized ? normalizeWsUrl(normalized) : null;
}

function normalizeRouteConnectionUrl(connectionUrl: string | null | undefined): string | null {
  const normalized = normalizeConnectionUrl(connectionUrl);
  if (!normalized || normalized === normalizeWsUrl(resolveLocalDeviceWsUrl())) {
    return null;
  }
  return normalized;
}

export function encodeThreadBoardRoutePane(input: ChatThreadBoardRoutePane): string {
  const connectionUrl = normalizeRouteConnectionUrl(input.connectionUrl);
  if (!connectionUrl) {
    return input.threadId;
  }
  return `${input.threadId}${THREAD_BOARD_CONNECTION_SEPARATOR}${connectionUrl}`;
}

export function decodeThreadBoardRoutePane(value: string): ChatThreadBoardRoutePane | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const [threadIdRaw, ...connectionParts] = trimmed.split(THREAD_BOARD_CONNECTION_SEPARATOR);
  const threadId = threadIdRaw?.trim();
  if (!threadId) {
    return null;
  }
  const connectionRaw = connectionParts.join(THREAD_BOARD_CONNECTION_SEPARATOR).trim();
  try {
    return {
      connectionUrl: normalizeRouteConnectionUrl(connectionRaw),
      threadId: ThreadId.makeUnsafe(threadId),
    };
  } catch {
    return null;
  }
}

export function parseThreadBoardRoutePanes(value: string | undefined): ChatThreadBoardRoutePane[] {
  if (!value) {
    return [];
  }
  const panes: ChatThreadBoardRoutePane[] = [];
  const seen = new Set<string>();
  for (const token of value.split(THREAD_BOARD_PANE_SEPARATOR)) {
    const pane = decodeThreadBoardRoutePane(token);
    if (!pane) {
      continue;
    }
    const key = encodeThreadBoardRoutePane(pane);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    panes.push(pane);
  }
  return panes;
}

export function serializeThreadBoardRoutePanes(
  panes: readonly ChatThreadBoardRoutePane[],
): string | undefined {
  if (panes.length <= 1) {
    return undefined;
  }
  return panes.map(encodeThreadBoardRoutePane).join(THREAD_BOARD_PANE_SEPARATOR);
}

export function buildThreadBoardRouteSearch(
  panes: readonly ChatThreadBoardRoutePane[],
  activePane: ChatThreadBoardRoutePane,
  input?: { splitId?: string | null },
): Record<string, string | undefined> {
  const serializedThreads = serializeThreadBoardRoutePanes(panes);
  return {
    [THREAD_BOARD_ACTIVE_SEARCH_PARAM]: serializedThreads
      ? encodeThreadBoardRoutePane(activePane)
      : undefined,
    [THREAD_BOARD_SPLIT_SEARCH_PARAM]: serializedThreads
      ? (input?.splitId ?? undefined)
      : undefined,
    [THREAD_BOARD_THREADS_SEARCH_PARAM]: serializedThreads,
    [THREAD_ROUTE_CONNECTION_SEARCH_PARAM]: normalizeRouteConnectionUrl(activePane.connectionUrl)
      ? activePane.connectionUrl!
      : undefined,
  };
}

export function buildSingleThreadRouteSearch(
  input?: { connectionUrl?: string | null } | null,
): Record<string, string | undefined> {
  const connectionUrl = normalizeRouteConnectionUrl(input?.connectionUrl);
  return {
    [THREAD_BOARD_ACTIVE_SEARCH_PARAM]: undefined,
    [THREAD_BOARD_SPLIT_SEARCH_PARAM]: undefined,
    [THREAD_BOARD_THREADS_SEARCH_PARAM]: undefined,
    [THREAD_ROUTE_CONNECTION_SEARCH_PARAM]: connectionUrl ?? undefined,
  };
}

export function buildSingleThreadRouteHref(
  threadId: ThreadId,
  input?: { connectionUrl?: string | null } | null,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(buildSingleThreadRouteSearch(input))) {
    if (typeof value === "string" && value.length > 0) {
      search.set(key, value);
    }
  }
  const serializedSearch = search.toString();
  return serializedSearch ? `/${threadId}?${serializedSearch}` : `/${threadId}`;
}
