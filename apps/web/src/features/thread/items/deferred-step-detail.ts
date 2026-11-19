import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * An opened step's output, diff or reasoning. Steps start folded, so its code loads after the
 * transcript has painted, warmed while idle (`preloadDeferred`).
 */
export const DeferredStepDetail = deferredComponent(() =>
  import("./step-detail.tsx").then((module) => module.StepDetail),
);
