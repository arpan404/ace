import { threadWorkspace } from "@/features/panels/index.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadComposerParts } from "./composer/deferred-parts.tsx";
import { DeferredInteractionCard } from "./interactions/deferred-card.ts";
import { DeferredReviewNote, DeferredReviewSummary } from "./items/deferred-review.ts";

export { DeferredInteractionCard };

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

/** The header's ⋯ menu items (the shared thread actions) and the summary's contents. */
export const DeferredThreadMenu = deferredComponent(() =>
  import("./header/thread-menu.tsx").then((module) => module.ThreadMenuItems),
);
/** The open thread's rename, pin and archive shortcuts, from the same chunk as its ⋯ menu. */
export const DeferredThreadHotkeys = deferredComponent(() =>
  import("./header/thread-menu.tsx").then((module) => module.ThreadHotkeys),
);
export const DeferredSummaryBody = deferredComponent(() =>
  import("./header/summary-body.tsx").then((module) => module.SummaryBody),
);

/**
 * The long-thread tools, loaded when first opened and warmed while idle: the turn timeline,
 * search within the thread and the catch-up card (ADR 0056: off the route's first paint).
 */
export const DeferredTurnsPanel = deferredComponent(() =>
  import("./long/timeline.tsx").then((module) => module.TurnsPanel),
);
export const DeferredSearchBar = deferredComponent(() =>
  import("./long/search-bar.tsx").then((module) => module.SearchBar),
);
export const DeferredCatchUpCard = deferredComponent(() =>
  import("./long/catch-up-card.tsx").then((module) => module.CatchUpCard),
);

export function preloadDeferred(): Promise<unknown> {
  return Promise.all([
    DeferredStepDetail.preload(),
    DeferredInteractionCard.preload(),
    DeferredReviewNote.preload(),
    DeferredReviewSummary.preload(),
    DeferredThreadMenu.preload(),
    DeferredSummaryBody.preload(),
    // The workspace's tab kinds (icons, badges, loaders), so a tool opens without waiting.
    threadWorkspace.load(),
    preloadComposerParts(),
    DeferredTurnsPanel.preload(),
    DeferredSearchBar.preload(),
    DeferredCatchUpCard.preload(),
  ]);
}
