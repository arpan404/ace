import { deferredComponent } from "@/lib/deferred-component.tsx";

/** An open work log's rows: logs start collapsed, so rows load after first paint. */
export const DeferredWorkLogSteps = deferredComponent(() =>
  import("./work-log-steps.tsx").then((module) => module.WorkLogSteps),
);
