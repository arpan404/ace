import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * The subagents block's code: only threads that launch subagents show one, so it loads on first
 * use or while the thread screen is idle, off the route's first paint (ADR 0056 route budget).
 */
export const DeferredSubagents = deferredComponent(() =>
  import("./subagents-view.tsx").then((module) => module.Subagents),
);

/** One disclosure at the first launch of a batch; its collapsed row's height is held meanwhile. */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  return (
    <Suspense fallback={<div aria-hidden className="h-9" />}>
      <DeferredSubagents.Component {...props} />
    </Suspense>
  );
}
