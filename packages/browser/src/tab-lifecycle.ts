import type { BrowserTabLifecycle } from "@ace/protocol";

/** When an idle tab is frozen, and when a frozen tab is discarded (ADR 0083). */
export interface TabLifecyclePolicy {
  freezeAfterMs: number;
  discardAfterMs: number;
}
export const defaultTabLifecycle: TabLifecyclePolicy = {
  freezeAfterMs: 15 * 60_000,
  discardAfterMs: 2 * 60 * 60_000,
};
export interface TabActivity {
  tabId: string;
  lifecycle: BrowserTabLifecycle;
  /** The person is looking at it. */
  viewed: boolean;
  /** Commands are queued or running on it. */
  busy: boolean;
  /** A dialog, download, recording or held lease keeps it awake. */
  pinned: boolean;
  lastActiveAt: number;
}
export interface TabTransition {
  tabId: string;
  to: BrowserTabLifecycle;
}

/**
 * The lifecycle changes due at `now`. Pure: the caller applies them. A viewed, busy or pinned
 * tab is never frozen or discarded; using a tab wakes it before its command runs.
 */
export function tabTransitions(
  tabs: readonly TabActivity[],
  now: number,
  policy: TabLifecyclePolicy = defaultTabLifecycle,
): TabTransition[] {
  const due: TabTransition[] = [];
  for (const tab of tabs) {
    if (tab.viewed || tab.busy || tab.pinned || tab.lifecycle === "discarded") continue;
    const idle = now - tab.lastActiveAt;
    if (idle >= policy.discardAfterMs) due.push({ tabId: tab.tabId, to: "discarded" });
    else if (idle >= policy.freezeAfterMs && tab.lifecycle === "live")
      due.push({ tabId: tab.tabId, to: "frozen" });
  }
  return due;
}
