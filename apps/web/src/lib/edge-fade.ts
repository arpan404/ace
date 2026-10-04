import { useLayoutEffect, useState, type RefObject } from "react";

/** How wide the fade at a clipped edge is. */
const fade = 16;

/** Which edges of a horizontal scroller have more content past them. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

/** `ScrollEdges` for the element, measured on scroll and resize. */
export function useScrollEdges(scroller: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft > 0;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    if (typeof ResizeObserver === "undefined")
      return () => element.removeEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  });
  return edges;
}

/**
 * A mask for a horizontal scroller that fades whichever edge has more content past it, so a
 * clipped row (a tab, a line of source) reads as "more this way" rather than cut off. Undefined
 * while everything fits. Apply it as `mask-image`.
 */
export function useEdgeFade(scroller: RefObject<HTMLElement | null>): string | undefined {
  const edges = useScrollEdges(scroller);
  if (!edges.start && !edges.end) return undefined;
  const from = edges.start ? `transparent, #000 ${fade}px` : "#000";
  const to = edges.end ? `#000 calc(100% - ${fade}px), transparent` : "#000";
  return `linear-gradient(to right, ${from}, ${to})`;
}
