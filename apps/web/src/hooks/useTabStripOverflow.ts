import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SIDEBAR_RESIZE_END_EVENT, isLayoutResizeInProgress } from "~/lib/desktopChrome";

function syncTabStripOverflow(
  tabStripRef: RefObject<HTMLElement | null>,
  tabsOverflowRef: RefObject<boolean>,
  setTabsOverflow: (nextOverflow: boolean) => void,
) {
  const tabStrip = tabStripRef.current;
  const nextOverflow = tabStrip ? tabStrip.scrollWidth - tabStrip.clientWidth > 1 : false;
  if (tabsOverflowRef.current === nextOverflow) {
    return;
  }
  tabsOverflowRef.current = nextOverflow;
  setTabsOverflow(nextOverflow);
}

export function useTabStripOverflow<TElement extends HTMLElement = HTMLDivElement>() {
  const tabStripRef = useRef<TElement | null>(null);
  const tabsOverflowRef = useRef(false);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  useLayoutEffect(() => {
    if (!isLayoutResizeInProgress()) {
      syncTabStripOverflow(tabStripRef, tabsOverflowRef, setTabsOverflow);
      return;
    }
    const syncAfterLayoutResize = () => {
      syncTabStripOverflow(tabStripRef, tabsOverflowRef, setTabsOverflow);
    };
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, syncAfterLayoutResize, { once: true });
    window.addEventListener("ace:native-window-resize-end", syncAfterLayoutResize, { once: true });
    return () => {
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, syncAfterLayoutResize);
      window.removeEventListener("ace:native-window-resize-end", syncAfterLayoutResize);
    };
  }, []);

  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      return;
    }

    let frameId: number | null = null;
    let pendingDeferredSync = false;
    const syncOnFrame = () => {
      frameId = null;
      pendingDeferredSync = false;
      syncTabStripOverflow(tabStripRef, tabsOverflowRef, setTabsOverflow);
    };
    const scheduleTabsOverflowSync = () => {
      if (isLayoutResizeInProgress()) {
        pendingDeferredSync = true;
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(syncOnFrame);
    };
    const handleLayoutResizeEnd = () => {
      if (pendingDeferredSync) {
        scheduleTabsOverflowSync();
      }
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleTabsOverflowSync);
    resizeObserver?.observe(tabStrip);

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleTabsOverflowSync);
    mutationObserver?.observe(tabStrip, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
    window.addEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener(SIDEBAR_RESIZE_END_EVENT, handleLayoutResizeEnd);
      window.removeEventListener("ace:native-window-resize-end", handleLayoutResizeEnd);
    };
  }, []);

  return { tabStripRef, tabsOverflow };
}
