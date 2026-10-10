import { useEffect } from "react";
import type { RefObject } from "react";

const paneCenterVar = "--toast-pane-center";
const paneWidthVar = "--toast-pane-width";

/**
 * Centres toasts over the main pane, clear of the side panels: publishes the pane's
 * horizontal centre and width as custom properties, following resizes until unmount.
 */
export function useToastAnchor(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const root = element.ownerDocument.documentElement;
    const view = element.ownerDocument.defaultView;
    const place = () => {
      const box = element.getBoundingClientRect();
      root.style.setProperty(paneCenterVar, `${Math.round(box.left + box.width / 2)}px`);
      root.style.setProperty(paneWidthVar, `${Math.round(box.width)}px`);
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    view?.addEventListener("resize", place);
    place();
    return () => {
      observer.disconnect();
      view?.removeEventListener("resize", place);
      root.style.removeProperty(paneCenterVar);
      root.style.removeProperty(paneWidthVar);
    };
  }, [ref]);
}
