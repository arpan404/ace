import { useLayoutEffect, useState, type RefObject } from "react";
import type { Size } from "@ace/ui-core/devices";

/** An element's content size, kept current as it resizes; zero until it is laid out. */
export function useElementSize(element: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const measure = () =>
      setSize((before) =>
        before.width === target.clientWidth && before.height === target.clientHeight
          ? before
          : { width: target.clientWidth, height: target.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** Whether an element is on screen (or near it), so offscreen live tiles can pause. */
export function useOnScreen(element: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useLayoutEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "64px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return visible;
}
