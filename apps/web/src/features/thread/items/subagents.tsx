import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * The subagents block's code: only threads that launch subagents show one, so it loads on first
 * use or while the thread screen is idle, off the route's first paint (ADR 0056 route budget).
 */
export const DeferredSubagents = deferredComponent(() =>
  import("./subagents-view.tsx").then((module) => module.Subagents),
);

/**
 * The collapsed row's box while its code loads: the same padding, minimum height and two line
 * boxes (title and status), empty, so the row takes its place without moving what follows.
 */
function Holder() {
  return (
    <div aria-hidden className="py-1">
      <div className="flex min-h-(--row-height) pointer-coarse:min-h-11 items-center px-(--surface-inset) py-[calc(var(--setting-row-padding)/2)]">
        <span className="block">
          <span className="block text-ui">{"\u00a0"}</span>
          <span className="block text-xs">{"\u00a0"}</span>
        </span>
      </div>
    </div>
  );
}

/** One disclosure at the first launch of a batch; its collapsed row's box is held meanwhile. */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  return (
    <Suspense fallback={<Holder />}>
      <DeferredSubagents.Component {...props} />
    </Suspense>
  );
}
