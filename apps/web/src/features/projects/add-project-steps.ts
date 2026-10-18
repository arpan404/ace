import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * Add project's steps inside the palette, loaded with their first use (`add-project-flow`).
 * Its own module so the feature's index stays re-exports only: code of the index's own would
 * pull every module it re-exports into the page's first chunk.
 */
export const AddProjectSteps = deferredComponent(() =>
  import("./add-project-flow.tsx").then((module) => module.AddProjectFlow),
);
