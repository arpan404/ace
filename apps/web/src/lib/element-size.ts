import { useLayoutEffect, useState, type RefObject } from "react";

export interface Size {
  width: number;
  height: number;
}

const windowSize = (): Size => ({
  width: globalThis.innerWidth ?? 1440,
  height: globalThis.innerHeight ?? 900,
});

/**
 * An element's size, kept current while it resizes. Where there is no layout (tests) or no
 * ResizeObserver, the window's size stands in.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(windowSize);
  useLayoutEffect(() => {
    const element = ref.current;
    const measure = () => {
      const rect = element?.getBoundingClientRect();
      const next =
        rect && rect.width > 0 ? { width: rect.width, height: rect.height } : windowSize();
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    measure();
    if (element && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [ref]);
  return size;
}
