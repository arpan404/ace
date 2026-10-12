import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * A background task's line: only turns that start one show it, so its code loads on first use
 * or while the thread screen is idle, off the route's first paint (ADR 0056 route budget).
 */
export const DeferredBackgroundTask = deferredComponent(() =>
  import("./background-task-view.tsx").then((module) => module.BackgroundTaskLine),
);

/** A background task's one line; its height is held while its code loads. */
export function BackgroundTaskLine(props: { threadId: string; itemId: string; taskId: string }) {
  return (
    <Suspense fallback={<div aria-hidden className="h-8" />}>
      <DeferredBackgroundTask.Component {...props} />
    </Suspense>
  );
}
