import type { BrowserTabLifecycle } from "@ace/protocol";

/** When an idle tab rests, freezes, and is discarded (ADR 0083). */
export interface TabLifecyclePolicy {
  /** An idle tab stops drawing: its page is hidden, as a background tab is, but still runs. */
  restAfterMs: number;
  freezeAfterMs: number;
  discardAfterMs: number;
}
export const defaultTabLifecycle: TabLifecyclePolicy = {
  restAfterMs: 30_000,
  freezeAfterMs: 15 * 60_000,
  discardAfterMs: 2 * 60 * 60_000,
};
export interface TabActivity {
  tabId: string;
  lifecycle: BrowserTabLifecycle;
  /** Its page is hidden and draws nothing. */
  resting: boolean;
  /** The person is looking at it. */
  viewed: boolean;
  /**
   * The thread's shown tab, watched or not: the live capture is attached to its page, so it may
   * rest and freeze but is never discarded.
   */
  shown: boolean;
  /** Commands are queued or running on it. */
  busy: boolean;
  /** A dialog, download, recording or held lease keeps it awake. */
  pinned: boolean;
  lastActiveAt: number;
}
export interface TabTransition {
  tabId: string;
  to: BrowserTabLifecycle | "resting";
}

/**
 * The lifecycle changes due at `now`. Pure: the caller applies them. A viewed, busy or pinned
 * tab is never rested, frozen or discarded; using a tab wakes it before its command runs.
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
    if (idle >= policy.discardAfterMs && !tab.shown)
      due.push({ tabId: tab.tabId, to: "discarded" });
    else if (tab.lifecycle !== "live") continue;
    else if (idle >= policy.freezeAfterMs) due.push({ tabId: tab.tabId, to: "frozen" });
    else if (idle >= policy.restAfterMs && !tab.resting)
      due.push({ tabId: tab.tabId, to: "resting" });
  }
  return due;
}
