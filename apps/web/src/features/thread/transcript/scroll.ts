import { useEffect, type RefObject } from "react";
import { scrollToEnd as glideToEnd } from "@/lib/motion.ts";

/*
 * The transcript viewport's scroll behaviour: staying at the live end through resizes, the
 * scrollbar gutter the composer shares. Which row holds still as rows change is
 * `use-feed-scroll.ts`'s.
 */

/**
 * The reading column changes height when a panel opens, the composer grows or the window
 * resizes. A reader at the latest stays there: the end glides back into view (instantly under
 * reduced motion) instead of the newest lines ending up under the composer or the terminal.
 */
export function useStayPinned(
  viewport: RefObject<HTMLDivElement | null>,
  following: () => boolean,
  glidingUntil: RefObject<number>,
) {
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const content = el.firstElementChild;
    let height = el.clientHeight;
    let width = el.clientWidth;
    let clearance = content ? getComputedStyle(content).paddingBottom : "";
    const observer = new ResizeObserver(() => {
      const next = el.clientHeight;
      const nextWidth = el.clientWidth;
      const nextClearance = content ? getComputedStyle(content).paddingBottom : "";
      if (next === height && nextWidth === width && nextClearance === clearance) return;
      height = next;
      width = nextWidth;
      clearance = nextClearance;
      if (!following()) return;
      // The glide's own scroll events must not read as the reader scrolling away.
      glidingUntil.current = performance.now() + 800;
      glideToEnd(el, true);
    });
    observer.observe(el);
    // Its bottom padding changes when the overlaid composer grows (a staged attachment, a
    // deferred mount). Padding sits outside the content box a default observer watches.
    if (content) observer.observe(content, { box: "border-box" });
    return () => observer.disconnect();
  }, [viewport, following, glidingUntil]);
}

/** Pending messages change the live end without moving an older reading position. */
export function useDockShift(
  dock: RefObject<HTMLElement | null>,
  viewport: RefObject<HTMLElement | null>,
  following: () => boolean,
  toEnd: (view: HTMLElement) => void,
) {
  useEffect(() => {
    const el = dock.current;
    const view = viewport.current;
    if (!el || !view || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following()) toEnd(view);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [dock, viewport, following, toEnd]);
}

/**
 * Where scrollbars take room (not overlay ones), the transcript reserves it on both edges and
 * publishes one edge's width as `--transcript-gutter`, which the composer adds to its own sides,
 * so the composer's shell and the transcript's text share both edges at every width.
 */
export function useGutter(viewport: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const measure = () =>
      root.style.setProperty(
        "--transcript-gutter",
        `${Math.max(0, Math.round((el.offsetWidth - el.clientWidth) / 2))}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--transcript-gutter");
    };
  }, [viewport]);
}
