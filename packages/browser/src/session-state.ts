import type { BrowserState, BrowserOriginBlock } from "@ace/protocol";
import type { SessionOwnership } from "./session-ownership.ts";
import type { SessionOptions } from "./session-options.ts";

/** Project ownership and lifecycle facts without changing control. */
export function browserState(
  options: SessionOptions,
  ownership: SessionOwnership,
  lifecycle: {
    paused: boolean;
    closed: boolean;
    reason?: string | undefined;
    pageStateLost: boolean;
    lastUrl?: string | undefined;
    blocked?: BrowserOriginBlock | undefined;
  },
): BrowserState {
  const tabs = options.backend.tabs;
  return {
    threadId: options.threadId,
    controller: lifecycle.paused ? "none" : ownership.controller,
    ...(ownership.owner ? { owner: ownership.owner } : {}),
    url: (lifecycle.lastUrl ?? options.backend.url()).slice(0, 8192),
    backend: options.backendKind,
    ...options.backend.pageStatus?.(),
    status: lifecycle.paused ? "paused" : "ready",
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
    ...(lifecycle.pageStateLost ? { pageStateLost: true } : {}),
    ...(lifecycle.blocked ? { blocked: lifecycle.blocked } : {}),
    closed: lifecycle.closed,
    takeoverMode: ownership.mode,
    ...(tabs
      ? {
          activeTabId: tabs.active(),
          tabs: tabs.list(),
          downloads: tabs.downloads(),
          pending_dialog: tabs.dialog(),
        }
      : {}),
  };
}
