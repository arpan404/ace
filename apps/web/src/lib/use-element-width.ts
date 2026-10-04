import { useCallback, useState } from "react";

/**
 * An element's width in CSS px, following resizes: a dock tool picks a layout for the room it
 * has, not the window's. Pass the returned ref to the element; 0 until it mounts. Without
 * ResizeObserver (jsdom) it reads the width once.
 */
export function useElementWidth(): [ref: (element: HTMLElement | null) => void, width: number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setWidth(element.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
