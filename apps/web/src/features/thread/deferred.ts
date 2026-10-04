import { threadWorkspace } from "@/features/panels/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * Parts of the thread screen that only appear on demand: a step's detail (output, diff,
 * reasoning) when it is expanded, the card for a pending approval, question or plan, and the
 * header's menus. They
 * load after the transcript has painted, while the browser is idle, so they are ready before
 * they are needed without weighing on the route's first paint (ADR 0056 route budget).
 */
export const DeferredStepDetail = deferredComponent(() =>
  import("./items/step-detail.tsx").then((module) => module.StepDetail),
);
export const DeferredInteractionCard = deferredComponent(() =>
  import("./interactions/interaction-card.tsx").then((module) => module.InteractionCard),
);

/** The header's ⋯ menu items (the shared thread actions) and the summary's contents. */
export const DeferredThreadMenu = deferredComponent(() =>
  import("./header/thread-menu.tsx").then((module) => module.ThreadMenuItems),
);
export const DeferredSummaryBody = deferredComponent(() =>
  import("./header/summary-body.tsx").then((module) => module.SummaryBody),
);

export function preloadDeferred(): Promise<unknown> {
  return Promise.all([
    DeferredStepDetail.preload(),
    DeferredInteractionCard.preload(),
    DeferredThreadMenu.preload(),
    DeferredSummaryBody.preload(),
    // The workspace's tab kinds (icons, badges, loaders), so a tool opens without waiting.
    threadWorkspace.load(),
  ]);
}
