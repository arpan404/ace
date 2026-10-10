import { useLayoutEffect } from "react";

/** Custom properties the toast viewport reads: the main pane's centre and width, in px. */
const centerVar = "--toast-pane-center";
const widthVar = "--toast-pane-width";

/** Marks the element toasts centre over (the shell's main pane). */
export const toastAnchor = { "data-toast-anchor": "" } as const;

/**
 * Centres shown toasts over the main pane instead of the window, so they stay clear of the
 * side panel beside it (the desktop's native browser page would otherwise step aside for them).
 * The pane is measured whenever the shown toasts change and while the window resizes; it also
 * moves without resizing (the sidebar toggling), so observing its size alone would go stale.
 */
export function useToastAnchor(shown: readonly unknown[]): void {
  useLayoutEffect(() => {
    if (!shown.length || typeof document === "undefined") return;
    const root = document.documentElement;
    const place = () => {
      const pane = [...document.querySelectorAll("[data-toast-anchor]")]
        .map((element) => element.getBoundingClientRect())
        .find((box) => box.width > 0);
      if (!pane) {
        root.style.removeProperty(centerVar);
        root.style.removeProperty(widthVar);
        return;
      }
      root.style.setProperty(centerVar, `${Math.round(pane.left + pane.width / 2)}px`);
      root.style.setProperty(widthVar, `${Math.round(pane.width)}px`);
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [shown]);
}
