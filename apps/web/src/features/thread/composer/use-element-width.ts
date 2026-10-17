import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * An element's layout width: measured before the first paint, then whenever it resizes (a
 * panel opening, the window). Layout width, so a panel's transform mid-animation never skews
 * it; an element that isn't laid out (hidden, detached) keeps the last width. 0 until measured.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.offsetWidth > 0) setWidth(el.offsetWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
