import { lazy, Suspense, useCallback, useEffect } from "react";
import { useLocal } from "../store.ts";
import { quickOpen } from "./quick-open-store.ts";

// The palette's code loads the first time it opens; the overlay itself is a few lines that ride
// with the tab kinds.
const QuickOpenDialog = lazy(() =>
  import("./quick-open.tsx").then((module) => ({ default: module.QuickOpenDialog })),
);

/** The thread's ⌘P palette, drawn over the screen while `quickOpen` names this thread. */
export function QuickOpenOverlay(props: { scope: string }) {
  const open = useLocal(
    quickOpen,
    useCallback((scope: string | undefined) => scope === props.scope, [props.scope]),
  );
  // Leaving the thread's screen puts its palette away; it doesn't wait there for a return.
  useEffect(
    () => () => quickOpen.set((scope) => (scope === props.scope ? undefined : scope)),
    [props.scope],
  );
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <QuickOpenDialog threadId={props.scope} onClose={() => quickOpen.set(() => undefined)} />
    </Suspense>
  );
}
