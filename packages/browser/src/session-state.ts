import type { BrowserState, BrowserOriginBlock, BrowserTab } from "@ace/protocol";
import type { SessionOptions } from "./session-options.ts";

/**
 * The thread browser's state as clients read it. Who uses which tab (an agent's mark, a
 * private tab) is carried per tab; nobody holds the browser as a whole.
 */
export function browserState(
  options: SessionOptions,
  lifecycle: {
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
  return {
    threadId: options.threadId,
    url: (lifecycle.lastUrl ?? options.backend.url()).slice(0, 8192),
    backend: options.backendKind,
    ...options.backend.pageStatus?.(),
    status: lifecycle.paused ? "paused" : "ready",
    ...(lifecycle.reason ? { reason: lifecycle.reason } : {}),
    ...(lifecycle.pageStateLost ? { pageStateLost: true } : {}),
    ...(lifecycle.blocked ? { blocked: lifecycle.blocked } : {}),
    closed: lifecycle.closed,
    features: ["annotate", "tabs", "collaborate"],
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
