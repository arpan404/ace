import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * What the tab attached to the thread's composer shows. Its code (and the request card's) loads
 * before a thread with pending requests paints; the other tabs warm while idle. Apart from the
 * composer's other deferred parts, which the transcript's rows import: the request card reaches
 * back to those rows.
 */

/** The agent's open requests, as the deck of cards attached to the composer. */
export const DeferredRequestStack = deferredComponent(() =>
  import("./request-stack.tsx").then((module) => module.RequestStack),
);
/** The agents' to-do list: its current step, raised to the whole list. */
export const DeferredPlanTab = deferredComponent(() =>
  import("./plan-tab.tsx").then((module) => module.PlanTab),
);
/** "2 agents working · 1m 12s · Stop". */
export const DeferredStatusStrip = deferredComponent(() =>
  import("./status-strip.tsx").then((module) => module.StatusStrip),
);
export const DeferredEnvironmentStrip = deferredComponent(() =>
  import("./environment-strip.tsx").then((module) => module.EnvironmentStrip),
);
export function preloadComposerCards(): Promise<unknown> {
  return Promise.all([
    DeferredRequestStack.preload(),
    DeferredPlanTab.preload(),
    DeferredStatusStrip.preload(),
    DeferredEnvironmentStrip.preload(),
  ]);
}
