import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * A smoothness measurement's row and card (`measurement-step.tsx`): rare in transcripts, so its
 * result reader and views load only when an open work log holds one.
 */
export const DeferredMeasurementStep = deferredComponent(() =>
  import("./measurement-step.tsx").then((module) => module.MeasurementStep),
);
