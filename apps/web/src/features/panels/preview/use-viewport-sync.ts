import { useLayoutEffect, useRef, type RefObject } from "react";
import type { PreviewSource } from "../sources.ts";

/** Coalesce a drag-resize of the panel into one viewport change once it settles. */
const settle = 150;

/**
 * Keep the remote browser's viewport the size of the pane showing it, so the page renders 1:1
 * rather than as a scaled-down picture. Sends the size once on mount (and whenever `active`
 * turns on, e.g. when the full view closes and the pane takes over again), then debounced on
 * every resize. A backend that can't resize keeps its size, and the frame is scaled to fit.
 */
export function useViewportSync(
  source: PreviewSource,
  threadId: string,
  pane: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  const last = useRef("");
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || !active) return;
    last.current = "";
    const send = () => {
      const width = Math.floor(el.offsetWidth);
      const height = Math.floor(el.offsetHeight);
      // Hidden (a background tab, a collapsed panel): keep the page as it is.
      if (width <= 0 || height <= 0) return;
      const key = `${width}x${height}`;
      if (key === last.current) return;
      last.current = key;
      source.resize(threadId, width, height);
    };
    send();
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(send, settle);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [source, threadId, pane, active]);
}
