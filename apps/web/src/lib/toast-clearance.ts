import { useCallback, type RefCallback } from "react";

const paneCenterVar = "--toast-pane-center";
const paneWidthVar = "--toast-pane-width";

/**
 * Centres toasts over the main pane, clear of the side panels: publishes the pane's
 * horizontal centre and width as custom properties, following resizes until unmount. Full
 * view hides the main pane, so use the visible sidebar, or the viewport when neither shows.
 */
export function useToastAnchor(): RefCallback<HTMLElement> {
  return useCallback((element) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const root = element.ownerDocument.documentElement;
    const view = element.ownerDocument.defaultView;
    const sidebar = element.ownerDocument.querySelector<HTMLElement>('[data-slot="sidebar-inner"]');
    const clear = () => {
      root.style.removeProperty(paneCenterVar);
      root.style.removeProperty(paneWidthVar);
    };
    const place = () => {
      let box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        if (!sidebar || sidebar.getAttribute("aria-hidden") === "true") return clear();
        box = sidebar.getBoundingClientRect();
      }
      const left = Math.max(0, box.left);
      const right = Math.min(view?.innerWidth ?? box.right, box.right);
      const width = right - left;
      // A hidden/offscreen box must not replace the toast viewport's usable CSS defaults.
      if (width <= 32 || box.height <= 0) return clear();
      root.style.setProperty(paneCenterVar, `${Math.round(left + width / 2)}px`);
      root.style.setProperty(paneWidthVar, `${Math.round(width)}px`);
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (sidebar) observer.observe(sidebar);
    // Collapse moves the sidebar offscreen without resizing it or the hidden main pane.
    const visibility = new MutationObserver(place);
    if (sidebar)
      visibility.observe(sidebar, { attributes: true, attributeFilter: ["aria-hidden"] });
    view?.addEventListener("resize", place);
    place();
    return () => {
      observer.disconnect();
      visibility.disconnect();
      view?.removeEventListener("resize", place);
      clear();
    };
  }, []);
}
