import type { DesktopDetachedWindowReturnRequest } from "@ace/contracts";

export const DETACHED_WINDOW_RETURN_EVENT = "ace:detached-window-return";

const DETACHED_WINDOW_RETURN_STORAGE_KEY = "ace:detached-window-return";

interface StoredDetachedWindowReturnRequest {
  request: DesktopDetachedWindowReturnRequest;
  requestId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDetachedWindowReturnRequest(
  value: unknown,
): value is DesktopDetachedWindowReturnRequest {
  if (!isObject(value)) {
    return false;
  }
  if (value.kind === "browser") {
    return value.scopeId === undefined || typeof value.scopeId === "string";
  }
  if (value.kind !== "editor" || typeof value.threadId !== "string") {
    return false;
  }
  return (
    (value.connectionUrl === undefined || typeof value.connectionUrl === "string") &&
    (value.placement === undefined ||
      value.placement === "bottom" ||
      value.placement === "right" ||
      value.placement === "workspace") &&
    (value.workspaceMode === undefined ||
      value.workspaceMode === "editor" ||
      value.workspaceMode === "split")
  );
}

export function resolveDetachedWindowReturnThreadId(
  request: DesktopDetachedWindowReturnRequest,
): string | null {
  if (request.kind === "editor") {
    return request.threadId;
  }
  if (!request.scopeId) {
    return null;
  }
  const [threadId] = request.scopeId.split(":browser:");
  return threadId && threadId !== request.scopeId ? threadId : null;
}

export function dispatchDetachedWindowReturnRequest(
  request: DesktopDetachedWindowReturnRequest,
): void {
  const storedRequest: StoredDetachedWindowReturnRequest = {
    request,
    requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`,
  };
  window.sessionStorage.setItem(DETACHED_WINDOW_RETURN_STORAGE_KEY, JSON.stringify(storedRequest));
  window.dispatchEvent(new CustomEvent(DETACHED_WINDOW_RETURN_EVENT, { detail: request }));
}

export function consumePendingDetachedWindowReturnRequest(
  threadId: string,
): DesktopDetachedWindowReturnRequest | null {
  const rawValue = window.sessionStorage.getItem(DETACHED_WINDOW_RETURN_STORAGE_KEY);
  if (!rawValue) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    window.sessionStorage.removeItem(DETACHED_WINDOW_RETURN_STORAGE_KEY);
    return null;
  }
  if (!isObject(parsed) || !isDetachedWindowReturnRequest(parsed.request)) {
    window.sessionStorage.removeItem(DETACHED_WINDOW_RETURN_STORAGE_KEY);
    return null;
  }
  const requestThreadId = resolveDetachedWindowReturnThreadId(parsed.request);
  if (requestThreadId !== threadId) {
    return null;
  }
  window.sessionStorage.removeItem(DETACHED_WINDOW_RETURN_STORAGE_KEY);
  return parsed.request;
}
