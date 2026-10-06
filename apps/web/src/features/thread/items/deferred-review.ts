import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadStepLabels } from "./step-labels.ts";

/*
 * Events, errors and ace's permission reviews, loaded after first paint (warmed with the
 * thread's other deferred parts): most transcripts have few, so their parsers and views stay
 * off the route's budget.
 */

/** Dividers, delegation and task cards, error rows and notices (`event-divider.tsx`). */
export const DeferredEvent = deferredComponent(() =>
  import("./event-divider.tsx").then((module) => module.EventBlock),
);
/** A failed turn's ending (`failed-turn.tsx`): it draws the same error row as a notice. */
export const DeferredFailedTurn = deferredComponent(() =>
  import("../transcript/failed-turn.tsx").then((module) => module.FailedTurn),
);
/** Copy on a finished answer (IR-14): shown on hover, so it loads after first paint. */
export const DeferredCopyAnswer = deferredComponent(() =>
  import("./copy-answer.tsx").then((module) => module.CopyAnswer),
);
/** Warming the review note warms the events too: they share the thread's idle preload. */
export const DeferredReviewNote = deferredComponent(() =>
  Promise.all([
    import("./review-note.tsx"),
    DeferredEvent.preload(),
    DeferredFailedTurn.preload(),
    DeferredCopyAnswer.preload(),
    preloadStepLabels(),
  ]).then(([module]) => module.ReviewNote),
);
export const DeferredReviewSummary = deferredComponent(() =>
  import("@/components/permission-review.tsx").then((module) => module.PermissionReviewSummary),
);
