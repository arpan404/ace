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
 * Rests idle tabs (their page hidden, drawing nothing), freezes them
 * (`Page.setWebLifecycleState`) and discards those idle past the discard threshold (#953), as
 * the pure policy says. A frozen tab rests too: a frozen page still composites its CSS
 * animations. Discarding drops the page; the tab reopens at its address on next use, its page
 * state reported lost. A backend that cannot discard leaves such a tab frozen, and one that
 * cannot rest leaves its idle pages drawing until they freeze. `viewed`: the person is looking
 * at this tab now; `shownId`: the tab the live capture shows.
 */
export async function settleIdleTabs(
  runtimes: readonly TabRuntime[],
  viewed: (runtime: TabRuntime) => boolean,
  shownId: string,
  now: number,
  policy: TabLifecyclePolicy,
  pinned: (runtime: TabRuntime) => boolean,
  tabs: BrowserBackendTabs | undefined,
): Promise<boolean> {
  const due = tabTransitions(
    runtimes.map((runtime) => ({
      tabId: runtime.id,
      lifecycle: runtime.lifecycle,
      resting: tabs?.resting?.(runtime.id) ?? false,
      viewed: viewed(runtime),
      shown: runtime.id === shownId,
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
      if (to === "resting") await tabs?.rest?.(tabId, true);
      else if (to === "discarded" && tabs?.discard) {
        await tabs.discard(tabId);
        runtime.lifecycle = "discarded";
        changed = true;
      } else if (runtime.lifecycle === "live") {
        await tabs?.rest?.(tabId, true);
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
 * Brings an idle tab back before anything touches it: a resting page is shown again, a frozen
 * one runs again, a discarded one reopens at its address. Says which of the last two, or
 * `false` when the tab was live (resting or not).
 */
export async function wakeTab(
  runtime: TabRuntime,
  tabs: BrowserBackendTabs | undefined,
): Promise<false | "thawed" | "reopened"> {
  // A tab never stays hidden under a command: the screencast, screenshots and input need frames.
  if (tabs?.resting?.(runtime.id)) await tabs.rest?.(runtime.id, false);
  if (runtime.lifecycle === "live") return false;
  if (runtime.lifecycle === "discarded") {
    if (!tabs?.revive) throw new Error("Browser tab unavailable");
    await tabs.revive(runtime.id);
    runtime.lifecycle = "live";
    runtime.invalidate();
    // A new page: the agent's cursor and the title/favicon watch follow it there.
    runtime.rebind();
    return "reopened";
  }
  await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "active" });
  runtime.lifecycle = "live";
  return "thawed";
}
