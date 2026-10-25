import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * A thread being started, off the thread route's first paint. New thread warms it as it opens
 * and waits for it before it moves here, so the move never shows an empty pane. It lives apart
 * from `thread-view.tsx` so New thread can warm it without loading the whole thread screen.
 */
export const DeferredPendingThread = deferredComponent(() =>
  import("./pending-thread.tsx").then((m) => m.PendingThreadView),
);
export const preloadPendingThread = DeferredPendingThread.preload;
