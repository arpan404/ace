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

/** What a thread knows about its tabs' use, read again before each change is applied. */
export interface IdleContext {
  /** The person is looking at this tab now. */
  viewed(runtime: TabRuntime): boolean;
  /** The tab the live capture shows. */
  shownId(): string;
  /** A dialog, a download still arriving or a recording keeps the tab as it is. */
  pinned(runtime: TabRuntime): boolean;
  now(): number;
}

/**
 * Rests idle tabs (their page hidden, drawing nothing), freezes them
 * (`Page.setWebLifecycleState`) and discards those idle past the discard threshold (#953), as
 * the pure policy says. A frozen tab rests too: a frozen page still composites its CSS
 * animations. Discarding drops the page; the tab reopens at its address on next use, its page
 * state reported lost. A backend that cannot discard leaves such a tab frozen, and one that
 * cannot rest leaves its idle pages drawing until they freeze.
 *
 * Each tab's change runs in its lifecycle turn, in order with its wakes, and is decided from
 * the tab's use at that moment: a command or viewer that arrived meanwhile keeps it awake, and
 * one arriving during the change wakes the tab once the change is done.
 */
export async function settleIdleTabs(
  runtimes: readonly TabRuntime[],
  context: IdleContext,
  policy: TabLifecyclePolicy,
  tabs: BrowserBackendTabs | undefined,
): Promise<boolean> {
  let changed = false;
  for (const runtime of runtimes)
    await runtime
      .lifecycleTurn(async () => {
        const [due] = tabTransitions(
          [
            {
              tabId: runtime.id,
              lifecycle: runtime.lifecycle,
              resting: tabs?.resting?.(runtime.id) ?? false,
              viewed: context.viewed(runtime),
              shown: runtime.id === context.shownId(),
              busy: runtime.busy,
              pinned: context.pinned(runtime),
              lastActiveAt: runtime.lastActiveAt,
            },
          ],
          context.now(),
          policy,
        );
        if (!due) return;
        if (due.to === "resting") await tabs?.rest?.(runtime.id, true);
        else if (due.to === "discarded" && tabs?.discard) {
          await tabs.discard(runtime.id);
          runtime.lifecycle = "discarded";
          changed = true;
        } else if (runtime.lifecycle === "live") {
          await tabs?.rest?.(runtime.id, true);
          await runtime.page.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          runtime.lifecycle = "frozen";
          changed = true;
        }
      })
      // A page that cannot rest, freeze or be dropped stays as it is.
      .catch(() => {});
  return changed;
}

/**
 * Brings an idle tab back before anything touches it: a resting page is shown again, a frozen
 * one runs again, a discarded one reopens at its address. Says which of the last two, or
 * `false` when the tab was live (resting or not). Runs in the tab's lifecycle turn, so it waits
 * for a change under way rather than see the tab half-way through it.
 */
export function wakeTab(
  runtime: TabRuntime,
  tabs: BrowserBackendTabs | undefined,
  /** Told, in the turn and before any step, when the tab is not yet shown and running. */
  restoring: () => void = () => {},
): Promise<false | "thawed" | "reopened"> {
  return runtime.lifecycleTurn(async () => {
    if (runtime.lifecycle !== "live" || tabs?.resting?.(runtime.id)) restoring();
    // Always asked, even when nothing looks hidden: it waits for a hide or show still applying.
    // A tab never stays hidden under a command: the screencast, screenshots and input need frames.
    await tabs?.rest?.(runtime.id, false);
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
  });
}
