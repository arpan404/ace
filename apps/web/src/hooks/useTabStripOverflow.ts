import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useTabStripOverflow<TElement extends HTMLElement = HTMLDivElement>() {
  const tabStripRef = useRef<TElement | null>(null);
  const tabsOverflowRef = useRef(false);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  const syncTabsOverflow = useCallback(() => {
    const tabStrip = tabStripRef.current;
    const nextOverflow = tabStrip ? tabStrip.scrollWidth - tabStrip.clientWidth > 1 : false;
    if (tabsOverflowRef.current === nextOverflow) {
      return;
    }
    tabsOverflowRef.current = nextOverflow;
    setTabsOverflow(nextOverflow);
  }, []);

  useLayoutEffect(() => {
    syncTabsOverflow();
  }, [syncTabsOverflow]);

  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      return;
    }

    let frameId: number | null = null;
    const scheduleTabsOverflowSync = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        syncTabsOverflow();
      });
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

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [syncTabsOverflow]);

  return { tabStripRef, tabsOverflow, syncTabsOverflow };
}
