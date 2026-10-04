import { deferredComponent } from "@/lib/deferred-component.tsx";

/*
 * ace's permission reviews, loaded after first paint (warmed with the thread's other deferred
 * parts): most transcripts have none, so their parser and views stay off the route's budget.
 */
export const DeferredReviewNote = deferredComponent(() =>
  import("./review-note.tsx").then((module) => module.ReviewNote),
);
export const DeferredReviewSummary = deferredComponent(() =>
  import("@/components/permission-review.tsx").then((module) => module.PermissionReviewSummary),
);
