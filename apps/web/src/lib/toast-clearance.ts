import { useEffect } from "react";
import type { RefObject } from "react";

/** The custom property the toast viewport reads for its distance from the window's bottom. */
const toastBottomVar = "--toast-bottom";
const gap = 12;

/**
 * Keeps toasts clear of an element at the bottom of the window (the composer): while it is
 * mounted, toasts sit `gap` px above its top edge instead of over the input. Follows the
 * element as it grows and as panels or the window move it.
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const root = element.ownerDocument.documentElement;
    const view = element.ownerDocument.defaultView;
    const place = () => {
      const top = element.getBoundingClientRect().top;
      const height = view?.innerHeight ?? 0;
      root.style.setProperty(toastBottomVar, `${Math.max(gap, Math.round(height - top + gap))}px`);
    };
    // The element moves without resizing when a bottom panel opens, so watch its column too.
    const observer = new ResizeObserver(place);
    observer.observe(element);
    const column = element.closest("main");
    if (column) observer.observe(column);
    view?.addEventListener("resize", place);
    place();
    return () => {
      observer.disconnect();
      view?.removeEventListener("resize", place);
      root.style.removeProperty(toastBottomVar);
    };
  }, [ref]);
}
