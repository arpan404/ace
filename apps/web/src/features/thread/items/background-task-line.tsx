import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * A background task's line: only turns that start one show it, so its code loads on first use
 * or while the thread screen is idle, off the route's first paint (ADR 0056 route budget).
 */
export const DeferredBackgroundTask = deferredComponent(() =>
  import("./background-task.tsx").then((module) => module.BackgroundTaskLine),
);

/**
 * The line's box while its code loads: one 28px line, or, in a column narrower than 360px where
 * the command wraps under the label, the Stop button's line and the command's.
 */
function Holder() {
  return (
    <div aria-hidden className="@container">
      <div className="flex min-h-7 flex-wrap items-center gap-y-0.5">
        <span className="block h-6 w-px" />
        <span className="hidden h-5 basis-full @max-[360px]:block" />
      </div>
    </div>
  );
}

/** A background task's one line; its box is held while its code loads. */
export function BackgroundTaskLine(props: { threadId: string; itemId: string; taskId: string }) {
  return (
    <Suspense fallback={<Holder />}>
      <DeferredBackgroundTask.Component {...props} />
    </Suspense>
  );
}
