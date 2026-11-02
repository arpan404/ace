import { useEffect, type RefObject } from "react";
import { scrollToEnd as glideToEnd } from "@/lib/motion.ts";

/*
 * The transcript viewport's scroll behaviour: staying at the live end through resizes, the
 * scrollbar gutter the composer shares. Which row holds still as rows change is
 * `use-feed-scroll.ts`'s.
 */

/** What changed about the viewport since the last look. */
export interface ViewportChange {
  height: boolean;
  width: boolean;
  /** The bottom padding the overlaid composer reserves: the composer grew or shrank. */
  clearance: boolean;
  /** The strip at the end of the rows (queued messages) grew or shrank. */
  dock?: boolean | undefined;
}

/**
 * How a reader at the live end stays there through a resize: nothing changed, nothing moves; the
 * composer growing or shrinking (its clearance) moves the end at once, in step with the
 * composer, since a glide would trail behind it with each line typed; any other resize (a panel,
 * the window) glides. The dock strip's own changes are the caller's (`resized`), which keeps
 * the end through the virtualizer.
 */
export function pinnedMove(change: ViewportChange): "none" | "jump" | "glide" {
  if (change.clearance) return "jump";
  return change.height || change.width ? "glide" : "none";
}

/** Docked content at the end changed size (the composer's clearance or the dock strip). */
export const dockedChange = (change: ViewportChange): boolean => change.clearance || !!change.dock;

/**
 * The reading column changes height when a panel opens, the composer grows or the window
 * resizes, and its content when rows grow or the dock changes. A reader at the latest stays
 * there (`pinnedMove`): the end comes back into view instead of the newest lines ending up under
 * the composer or the terminal. Every resize is then reported (`resized`), after any move, so
 * the view's distance from the end is measured once per layout, never per delta.
 */
export function useStayPinned(
  viewport: RefObject<HTMLDivElement | null>,
  dock: RefObject<HTMLElement | null>,
  following: () => boolean,
  glidingUntil: RefObject<number>,
  resized: (view: HTMLElement, change: ViewportChange) => void,
) {
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const content = el.firstElementChild;
    const strip = dock.current;
    let height = el.clientHeight;
    let width = el.clientWidth;
    let clearance = content ? getComputedStyle(content).paddingBottom : "";
    const observer = new ResizeObserver((entries) => {
      const next = el.clientHeight;
      const nextWidth = el.clientWidth;
      const nextClearance = content ? getComputedStyle(content).paddingBottom : "";
      const change: ViewportChange = {
        height: next !== height,
        width: nextWidth !== width,
        clearance: nextClearance !== clearance,
        dock: !!strip && entries.some((entry) => entry.target === strip),
      };
      height = next;
      width = nextWidth;
      clearance = nextClearance;
      const move = pinnedMove(change);
      if (move === "jump" && following()) el.scrollTop = el.scrollHeight - el.clientHeight;
      else if (move === "glide" && following()) {
        // The glide's own scroll events must not read as the reader scrolling away.
        glidingUntil.current = performance.now() + 800;
        glideToEnd(el, true);
      }
      resized(el, change);
    });
    observer.observe(el);
    // Its bottom padding changes when the overlaid composer grows (a staged attachment, a
    // deferred mount). Padding sits outside the content box a default observer watches.
    if (content) observer.observe(content, { box: "border-box" });
    if (strip) observer.observe(strip);
    return () => observer.disconnect();
  }, [viewport, dock, following, glidingUntil, resized]);
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
