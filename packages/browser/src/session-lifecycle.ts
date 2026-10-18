import type { BrowserBackendTabs } from "./backend.ts";
import { tabTransitions, type TabLifecyclePolicy } from "./tab-lifecycle.ts";
import type { TabRuntime } from "./tab-runtime.ts";

/** Idle-tab freezing for one thread: a timer asks the pure policy, this applies its answer. */
export interface LifecycleSchedule {
  policy: TabLifecyclePolicy;
  /** How often to look; returns a cancel. */
  every: number;
  set(delay: number, work: () => void): () => void;
}

/**
 * Freezes idle tabs (`Page.setWebLifecycleState`) and discards those idle past the discard
 * threshold (#953), as the pure policy says. Discarding drops the page; the tab reopens at its
 * address on next use, its page state reported lost. A backend that cannot discard leaves such
 * a tab frozen.
 */
export async function settleIdleTabs(
  runtimes: readonly TabRuntime[],
  viewedId: string,
  now: number,
  policy: TabLifecyclePolicy,
  pinned: (runtime: TabRuntime) => boolean,
  tabs: BrowserBackendTabs | undefined,
): Promise<boolean> {
  const due = tabTransitions(
    runtimes.map((runtime) => ({
      tabId: runtime.id,
      lifecycle: runtime.lifecycle,
      viewed: runtime.id === viewedId,
      busy: runtime.busy,
      pinned: pinned(runtime),
      lastActiveAt: runtime.lastActiveAt,
    })),
    now,
    policy,
  );
  let changed = false;
  for (const { tabId, to } of due) {
    const runtime = runtimes.find((candidate) => candidate.id === tabId);
    if (!runtime) continue;
    try {
      if (to === "discarded" && tabs?.discard) {
        await tabs.discard(tabId);
        runtime.lifecycle = "discarded";
        changed = true;
      } else if (runtime.lifecycle === "live") {
        await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
        runtime.lifecycle = "frozen";
        changed = true;
      }
    } catch {
      // A page that cannot freeze or be dropped stays as it is.
    }
  }
  return changed;
}

/**
 * Brings an idle tab back before anything touches it: a frozen page runs again, a discarded
 * one reopens at its address. Says which, or `false` when the tab was live.
 */
export async function wakeTab(
  runtime: TabRuntime,
  tabs: BrowserBackendTabs | undefined,
): Promise<false | "thawed" | "reopened"> {
  if (runtime.lifecycle === "live") return false;
  if (runtime.lifecycle === "discarded") {
    if (!tabs?.revive) throw new Error("Browser tab unavailable");
    await tabs.revive(runtime.id);
    runtime.lifecycle = "live";
    runtime.invalidate();
    return "reopened";
  }
  await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "active" });
  runtime.lifecycle = "live";
  return "thawed";
}
