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
      root.style.removeProperty("--toast-pane-top");
      root.style.removeProperty("--toast-pane-bottom");
    };
    const pages = () => [
      ...element.ownerDocument.querySelectorAll<HTMLElement>("[data-browser-page]"),
    ];
    const place = () => {
      let box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        if (sidebar && sidebar.getAttribute("aria-hidden") !== "true")
          box = sidebar.getBoundingClientRect();
      }
      let left = Math.max(0, box.left);
      let right = Math.min(view?.innerWidth ?? box.right, box.right);
      const page = pages()
        .map((surface) => surface.getBoundingClientRect())
        .find((rectangle) => rectangle.width > 0 && rectangle.height > 0);
      if (page && page.width > 0 && page.height > 0 && page.left < right && page.right > left) {
        const before = Math.max(0, page.left - left),
          after = Math.max(0, right - page.right);
        if (before >= after) right = Math.min(right, page.left);
        else left = Math.max(left, page.right);
      }
      // With no readable free column, reserve the bottom-left rectangle in native placement.
      const fallback = right - left < 240 || box.height <= 0;
      if (fallback) {
        left = 16;
        right = Math.min(view?.innerWidth ?? 390, 452) - 16;
      }
      root.style.setProperty(
        "--toast-pane-top",
        fallback ? "auto" : "calc(max(var(--header-h,48px),env(safe-area-inset-top,0px)) + 12px)",
      );
      root.style.setProperty("--toast-pane-bottom", fallback ? "16px" : "auto");
      const width = right - left;
      // A hidden/offscreen box must not replace the toast viewport's usable CSS defaults.
      if (width <= 32) return clear();
      root.style.setProperty(paneCenterVar, `${Math.round(left + width / 2)}px`);
      root.style.setProperty(paneWidthVar, `${Math.round(width)}px`);
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (sidebar) observer.observe(sidebar);
    // Collapse moves the sidebar offscreen without resizing it or the hidden main pane.
    const changed = () => {
      for (const page of pages()) observer.observe(page);
      place();
    };
    const visibility = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches("[data-browser-page]") || node.querySelector("[data-browser-page]")),
            ),
        )
      )
        changed();
    });
    const portals = new MutationObserver(changed);
    portals.observe(element.ownerDocument.body, { childList: true });
    const workspace = element.closest("[data-workspace]");
    if (workspace)
      visibility.observe(workspace, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden"],
      });
    if (sidebar)
      visibility.observe(sidebar, { attributes: true, attributeFilter: ["aria-hidden"] });
    view?.addEventListener("resize", place);
    place();
    return () => {
      observer.disconnect();
      visibility.disconnect();
      portals.disconnect();
      view?.removeEventListener("resize", place);
      clear();
    };
  }, []);
}
