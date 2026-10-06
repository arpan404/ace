import { useLayoutEffect, type RefObject } from "react";
import type { PreviewSource } from "../sources.ts";

/** Viewer pixel demand is independent of the controller's CSS viewport. */
export function useCaptureSize(
  source: PreviewSource,
  threadId: string,
  pane: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !source.capture) return;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const width = Math.floor(element.offsetWidth),
        height = Math.floor(element.offsetHeight);
      if (width <= 0 || height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const key = `${width}x${height}@${dpr}`;
      if (key === last) return;
      last = key;
      source.capture?.(threadId, width, height, dpr);
    };
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(send, 150);
    };
    send();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(changed);
    observer?.observe(element);
    window.addEventListener("resize", changed);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", changed);
    };
  }, [source, threadId, pane]);
}
