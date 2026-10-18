import type { UserBrowserOperation, UserBrowserToExtension } from "@ace/protocol";
import type { ControllerState } from "./controller.ts";

/**
 * Decoders for what reaches the extension. The native host already validated daemon messages
 * against the protocol schemas; these checks keep the extension correct on its own without
 * bundling a schema library into the service worker.
 */
type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const tabId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const links = ["connecting", "connected", "unauthorized", "unavailable"] as const;

function operation(raw: unknown): UserBrowserOperation | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.op) {
    case "tabs.list":
    case "stop":
      return { op: raw.op };
    case "tabs.open":
      if (raw.url === undefined) return { op: "tabs.open" };
      return text(raw.url, 8192) ? { op: "tabs.open", url: raw.url } : undefined;
    case "tabs.attach":
    case "tabs.detach":
    case "tabs.close":
      return tabId(raw.tabId) ? { op: raw.op, tabId: raw.tabId } : undefined;
    case "tabs.mute":
      return tabId(raw.tabId) && typeof raw.muted === "boolean"
        ? { op: "tabs.mute", tabId: raw.tabId, muted: raw.muted }
        : undefined;
    case "cdp":
      if (!tabId(raw.tabId) || !text(raw.method, 256) || !raw.method) return undefined;
      if (raw.params !== undefined && !isRecord(raw.params)) return undefined;
      if (raw.sessionId !== undefined && (!text(raw.sessionId, 128) || !raw.sessionId))
        return undefined;
      return {
        op: "cdp",
        tabId: raw.tabId,
        ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
        method: raw.method,
        ...(raw.params === undefined ? {} : { params: raw.params }),
      };
    default:
      return undefined;
  }
}

export function decodeFromHost(raw: unknown): UserBrowserToExtension | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "user_browser.link") {
    const state = links.find((entry) => entry === raw.state);
    if (!state) return undefined;
    return {
      type: "user_browser.link",
      state,
      ...(text(raw.detail, 512) ? { detail: raw.detail } : {}),
    };
  }
  if (raw.type === "user_browser.registered")
    return text(raw.requestId, 256) && text(raw.connectionId, 256)
      ? { type: raw.type, requestId: raw.requestId, connectionId: raw.connectionId }
      : undefined;
  if (raw.type === "user_browser.command" && text(raw.id, 256) && raw.id) {
    const decoded = operation(raw.operation);
    return decoded ? { type: raw.type, id: raw.id, operation: decoded } : undefined;
  }
  return undefined;
}

export type PopupRequest =
  | { kind: "state" | "stop" }
  | { kind: "share" | "unshare"; tabId: number };
export type PopupState = ControllerState;
export type PopupResponse = { ok: true; state: PopupState } | { ok: false; error: string };

export function decodePopupRequest(raw: unknown): PopupRequest | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "state" || raw.kind === "stop") return { kind: raw.kind };
  if ((raw.kind === "share" || raw.kind === "unshare") && tabId(raw.tabId))
    return { kind: raw.kind, tabId: raw.tabId };
  return undefined;
}

/** The service worker built this response itself; only its envelope is checked. */
export function decodePopupResponse(raw: unknown): PopupResponse | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.ok === false && typeof raw.error === "string") return { ok: false, error: raw.error };
  if (raw.ok === true && isRecord(raw.state) && Array.isArray(raw.state.tabs))
    return { ok: true, state: raw.state as unknown as PopupState };
  return undefined;
}
