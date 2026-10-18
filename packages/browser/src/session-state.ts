import type { BrowserState, BrowserOriginBlock, BrowserTab } from "@ace/protocol";
import type { SessionOwnership } from "./session-ownership.ts";
import type { SessionOptions } from "./session-options.ts";

/**
 * Project ownership and lifecycle facts without changing control. Thread-level controller,
 * owner and takeover mode are the viewed tab's; each tab carries its own lease.
 */
export function browserState(
  options: SessionOptions,
  lifecycle: {
    viewed?: SessionOwnership | undefined;
    tabs?: BrowserTab[] | undefined;
    activeTabId?: string | undefined;
    paused: boolean;
    closed: boolean;
    reason?: string | undefined;
    pageStateLost: boolean;
    lastUrl?: string | undefined;
    blocked?: BrowserOriginBlock | undefined;
    annotation?: string | undefined;
  },
): BrowserState {
  const tabs = options.backend.tabs;
  const ownership = lifecycle.viewed;
  return {
    threadId: options.threadId,
    controller: lifecycle.paused ? "none" : (ownership?.controller ?? "none"),
    ...(ownership?.owner ? { owner: ownership.owner } : {}),
    url: (lifecycle.lastUrl ?? options.backend.url()).slice(0, 8192),
    backend: options.backendKind,
    ...options.backend.pageStatus?.(),
    status: lifecycle.paused ? "paused" : "ready",
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
    ...(lifecycle.pageStateLost ? { pageStateLost: true } : {}),
    ...(lifecycle.blocked ? { blocked: lifecycle.blocked } : {}),
    closed: lifecycle.closed,
    takeoverMode: ownership?.mode ?? "shared",
    features: ["annotate", "tabs"],
    ...(lifecycle.annotation ? { annotation: { owner: lifecycle.annotation } } : {}),
    ...(tabs
      ? {
          ...(lifecycle.activeTabId ? { activeTabId: lifecycle.activeTabId } : {}),
          tabs: lifecycle.tabs ?? tabs.list(),
          downloads: tabs.downloads(),
          pending_dialog: tabs.dialog(),
        }
      : {}),
  };
}
