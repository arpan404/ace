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
 * Freezes idle tabs (`Page.setWebLifecycleState`). Discarding is decided by the same policy but
 * applied conservatively: a tab due for discard stays frozen, so its page state is never lost
 * behind an agent's back.
 */
export async function freezeIdleTabs(
  runtimes: readonly TabRuntime[],
  viewedId: string,
  now: number,
  policy: TabLifecyclePolicy,
  pinned: (runtime: TabRuntime) => boolean,
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
  for (const { tabId } of due) {
    const runtime = runtimes.find((candidate) => candidate.id === tabId);
    if (!runtime || runtime.lifecycle !== "live") continue;
    try {
      await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      runtime.lifecycle = "frozen";
      changed = true;
    } catch {
      // A page that cannot freeze stays live.
    }
  }
  return changed;
}

/** A frozen tab runs again before anything touches it. */
export async function wakeTab(runtime: TabRuntime): Promise<boolean> {
  if (runtime.lifecycle === "live") return false;
  await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "active" });
  runtime.lifecycle = "live";
  return true;
}
