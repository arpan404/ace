import { useLayoutEffect, useState, type RefObject } from "react";
export { useClientSize as useElementSize } from "@/lib/client-size.ts";

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
