import { useEffect, type RefObject } from "react";

/**
 * Type-to-focus (UX audit CMP-2): printable keys typed on the page or the transcript go to the
 * composer. The listener's code loads with the effect, off the thread route's first paint.
 */
export function useTypeToFocus(input: RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let stop: (() => void) | undefined;
    void import("./type-to-focus.ts").then((module) => {
      if (live) stop = module.listenTypeToFocus(input);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [input, enabled]);
}
