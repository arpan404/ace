import { DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM } from "@ace/contracts";
import { newCommandId, newMessageId, newProjectId, newThreadId, randomUUID } from "@ace/shared/ids";
import { String, Predicate } from "effect";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export { randomUUID, newCommandId, newProjectId, newThreadId, newMessageId };

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

const isNonEmptyString = Predicate.compose(Predicate.isString, String.isNonEmpty);
const ACTIVE_WS_URL_OVERRIDE_STORAGE_KEY = "ace.active-ws-url";

export function loadActiveWsUrlOverride(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const value = window.sessionStorage?.getItem(ACTIVE_WS_URL_OVERRIDE_STORAGE_KEY);
    return isNonEmptyString(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function persistActiveWsUrlOverride(value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage?.setItem(ACTIVE_WS_URL_OVERRIDE_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures and fall back to local resolution.
  }
}

export function clearActiveWsUrlOverride(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage?.removeItem(ACTIVE_WS_URL_OVERRIDE_STORAGE_KEY);
  } catch {
    // Ignore storage failures and keep current session behavior.
  }
}

export function clearBootstrapWsUrlQueryParam(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (
    typeof window.history?.replaceState !== "function" ||
    typeof window.location?.href !== "string"
  ) {
    return;
  }
  const currentUrl = new URL(window.location.href);
  if (!currentUrl.searchParams.has(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM)) {
    return;
  }
  currentUrl.searchParams.delete(DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM);
  const nextSearch = currentUrl.searchParams.toString();
  const replacement = `${currentUrl.pathname}${nextSearch.length > 0 ? `?${nextSearch}` : ""}${currentUrl.hash}`;
  window.history.replaceState(window.history.state, "", replacement);
}

function readRendererBootstrapWsUrl(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const value = new URLSearchParams(window.location.search).get(
    DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM,
  );
  return isNonEmptyString(value) ? value : undefined;
}

function readDesktopBridgeWsUrl(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!window.desktopBridge?.getWsUrl) {
    return undefined;
  }

  try {
    const value = window.desktopBridge.getWsUrl();
    return isNonEmptyString(value) ? value : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : globalThis.String(error);
    console.warn("Failed to read desktop WebSocket URL from bridge.", detail);
    return undefined;
  }
}

export const resolveServerUrl = (options?: {
  url?: string | undefined;
  protocol?: "http" | "https" | "ws" | "wss" | undefined;
  pathname?: string | undefined;
  searchParams?: Record<string, string> | undefined;
}): string => {
  const rawUrl =
    (isNonEmptyString(options?.url) ? options.url : undefined) ??
    loadActiveWsUrlOverride() ??
    readDesktopBridgeWsUrl() ??
    (isNonEmptyString(import.meta.env.VITE_WS_URL) ? import.meta.env.VITE_WS_URL : undefined) ??
    (typeof window !== "undefined" && isNonEmptyString(window.location.origin)
      ? window.location.origin
      : undefined) ??
    readRendererBootstrapWsUrl();

  if (!rawUrl) {
    throw new Error("No non-empty server URL provided");
  }

  const parsedUrl = new URL(rawUrl);
  if (options?.protocol) {
    parsedUrl.protocol = options.protocol;
  }
  if (options?.pathname) {
    parsedUrl.pathname = options.pathname;
  } else {
    parsedUrl.pathname = "/";
  }
  if (options?.searchParams) {
    parsedUrl.search = new URLSearchParams(options.searchParams).toString();
  }
  return parsedUrl.toString();
};
