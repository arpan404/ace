import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useTabStripOverflow<TElement extends HTMLElement = HTMLDivElement>() {
  const tabStripRef = useRef<TElement | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  const syncTabsOverflow = useCallback(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      setTabsOverflow(false);
      return;
    }
    const nextOverflow = tabStrip.scrollWidth - tabStrip.clientWidth > 1;
    setTabsOverflow((current) => (current === nextOverflow ? current : nextOverflow));
  }, []);

  useLayoutEffect(() => {
    syncTabsOverflow();
  });

  useLayoutEffect(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip || typeof ResizeObserver === "undefined") {
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

    const resizeObserver = new ResizeObserver(scheduleTabsOverflowSync);
    resizeObserver.observe(tabStrip);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
    };
  }, [syncTabsOverflow]);

  return { tabStripRef, tabsOverflow, syncTabsOverflow };
}
