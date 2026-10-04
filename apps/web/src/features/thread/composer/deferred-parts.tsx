import { deferredComponent } from "@/lib/deferred-component.tsx";
import { preloadComposerMenus } from "./deferred-menus.tsx";

/*
 * Composer parts that aren't the bare input and footer: the thread's footer controls, the queue
 * above it and the suggestion list, plus the menus. Their code loads after the thread has
 * painted, warmed while idle with the rest of `preloadDeferred`, which keeps the thread route
 * inside its ADR 0056 budget.
 */
export const DeferredThreadControls = deferredComponent(() =>
  import("./thread-controls.tsx").then((module) => module.ThreadControls),
);
export const DeferredQueuedPills = deferredComponent(() =>
  import("./queued.tsx").then((module) => module.QueuedPills),
);
export const DeferredQueueNotice = deferredComponent(() =>
  import("./queue-notice.tsx").then((module) => module.QueueNotice),
);
export const DeferredSuggestionList = deferredComponent(() =>
  import("./suggestion-list.tsx").then((module) => module.SuggestionList),
);

export function preloadComposerParts(): Promise<unknown> {
  return Promise.all([
    preloadComposerMenus(),
    DeferredThreadControls.preload(),
    DeferredQueuedPills.preload(),
    DeferredQueueNotice.preload(),
    DeferredSuggestionList.preload(),
  ]);
}

/** Room for the thread's footer controls while their code arrives: same height, nothing drawn. */
export function ControlsPending() {
  return <span aria-hidden className="h-(--composer-control) w-40 shrink" />;
}
