import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * Events, errors and ace's permission reviews, loaded after first paint (warmed with the
 * thread's other deferred parts): most transcripts have few, so their parsers and views stay
 * off the route's budget.
 */

/** Dividers, delegation and task cards, error rows and notices (`event-divider.tsx`). */
export const DeferredEvent = deferredComponent(() =>
  import("./event-divider.tsx").then((module) => module.EventBlock),
);
/** Warming the review note warms the events too: they share the thread's idle preload. */
export const DeferredReviewNote = deferredComponent(() =>
  Promise.all([import("./review-note.tsx"), DeferredEvent.preload()]).then(
    ([module]) => module.ReviewNote,
  ),
);
export const DeferredReviewSummary = deferredComponent(() =>
  import("@/components/permission-review.tsx").then((module) => module.PermissionReviewSummary),
);
