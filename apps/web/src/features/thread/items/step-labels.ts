import type { StepLabels } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

/*
 * Tool and approval wording for step rows ("Opened youtube.com", "Approved by you"), loaded
 * after first paint with the thread's other deferred parts: rows start collapsed, and until it
 * arrives a step reads plainly. Commands and paths don't wait for it.
 */

let labels: StepLabels | undefined;
let loading: Promise<StepLabels> | undefined;
const listeners = new Set<() => void>();

export function preloadStepLabels(): Promise<StepLabels> {
  return (loading ??= import("@ace/ui-core/step-labels").then((module): StepLabels => {
    const loaded = module.stepLabels;
    labels = loaded;
    for (const listener of listeners) listener();
    return loaded;
  }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void preloadStepLabels();
  return () => listeners.delete(listener);
}

export function useStepLabels(): StepLabels | undefined {
  return useSyncExternalStore(
    subscribe,
    () => labels,
    () => undefined,
  );
}
