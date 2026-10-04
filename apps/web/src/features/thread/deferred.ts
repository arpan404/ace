import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadComposerMenus } from "./composer/deferred-menus.tsx";

/*
 * Parts of the thread screen that only appear on demand: a step's detail (output, diff,
 * reasoning) when it is expanded, and the card for a pending approval, question or plan. They
 * load after the transcript has painted, while the browser is idle, so they are ready before
 * they are needed without weighing on the route's first paint (ADR 0056 route budget).
 */
export const DeferredStepDetail = deferredComponent(() =>
  import("./items/step-detail.tsx").then((module) => module.StepDetail),
);
export const DeferredInteractionCard = deferredComponent(() =>
  import("./interactions/interaction-card.tsx").then((module) => module.InteractionCard),
);

export function preloadDeferred(): Promise<unknown> {
  return Promise.all([
    DeferredStepDetail.preload(),
    DeferredInteractionCard.preload(),
    preloadComposerMenus(),
  ]);
}
