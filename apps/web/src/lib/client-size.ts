import { useLayoutEffect, useState, type RefObject } from "react";
import type { Size } from "@ace/ui-core/devices";

/** An element's client size, kept current as it resizes; zero until it is laid out. */
export function useClientSize(element: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    let previous: Size = { width: 0, height: 0 };
    const measure = () => {
      const width = target.clientWidth;
      const height = target.clientHeight;
      if (previous.width === width && previous.height === height) return;
      previous = { width, height };
      setSize(previous);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return size;
}
