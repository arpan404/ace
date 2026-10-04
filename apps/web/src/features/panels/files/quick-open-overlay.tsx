import { lazy, Suspense, useCallback, useEffect } from "react";
import { useLocal } from "../store.ts";
import { quickOpen } from "./quick-open-store.ts";

// The palette's code loads the first time it opens; the overlay itself is a few lines that ride
// with the tab kinds.
const QuickOpenDialog = lazy(() =>
  import("./quick-open.tsx").then((module) => ({ default: module.QuickOpenDialog })),
);

/** Overlays mounted per thread, so a remount doesn't count as leaving. */
const mounted = new Map<string, number>();

/** The thread's ⌘P palette, drawn over the screen while `quickOpen` names this thread. */
export function QuickOpenOverlay(props: { scope: string }) {
  const open = useLocal(
    quickOpen,
    useCallback((scope: string | undefined) => scope === props.scope, [props.scope]),
  );
  // Leaving the thread's screen puts its palette away; it doesn't wait there for a return. A
  // remount (Strict Mode, a kinds reload) mounts it again before the check runs.
  useEffect(() => {
    const scope = props.scope;
    mounted.set(scope, (mounted.get(scope) ?? 0) + 1);
    return () => {
      mounted.set(scope, (mounted.get(scope) ?? 1) - 1);
      queueMicrotask(() => {
        if (!mounted.get(scope)) quickOpen.set((open) => (open === scope ? undefined : open));
      });
    };
  }, [props.scope]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <QuickOpenDialog threadId={props.scope} onClose={() => quickOpen.set(() => undefined)} />
    </Suspense>
  );
}
