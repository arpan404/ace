import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { scrollToEnd as glideToEnd } from "@/lib/motion.ts";

/*
 * The transcript viewport's scroll behaviour: staying at the live end through resizes, the
 * scrollbar gutter the composer shares, and keeping the reader's row in place when rows are
 * added or removed above it (older history paging in, a jumped window sliding).
 */

/**
 * The reading column changes height when a panel opens, the composer grows or the window
 * resizes. A reader at the latest stays there: the end glides back into view (instantly under
 * reduced motion) instead of the newest lines ending up under the composer or the terminal.
 */
export function useStayPinned(
  viewport: RefObject<HTMLDivElement | null>,
  pinned: RefObject<boolean>,
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
      if (!pinned.current) return;
      // The glide's own scroll events must not read as the reader scrolling away.
      glidingUntil.current = performance.now() + 800;
      glideToEnd(el, true);
    });
    observer.observe(el);
    // Its bottom padding changes when the overlaid composer grows, including a deferred mount.
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [viewport, pinned, glidingUntil]);
}

/** Pending messages change the live end without moving an older reading position. */
export function useDockShift(
  dock: RefObject<HTMLElement | null>,
  viewport: RefObject<HTMLElement | null>,
  pinned: RefObject<boolean>,
) {
  useEffect(() => {
    const el = dock.current;
    const view = viewport.current;
    if (!el || !view || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) view.scrollTop = view.scrollHeight - view.clientHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [dock, viewport, pinned]);
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

/** The row at the top of the viewport and how far its top sits from the viewport's. */
export interface Anchor {
  key: string | number;
  index: number;
  offset: number;
  /** An item the row shows, to find it again once it folds into its turn or opens out of it. */
  itemId?: string | undefined;
}

/**
 * Keep the anchored row where the reader saw it when rows change above it: older history
 * prepended, a jumped window sliding newer (its oldest rows leave) or older, or turns folding.
 * A row that folded into its turn (or opened out of it) is found by an item it shows; a row
 * that is gone (left the window) leaves the scroll as it is.
 */
export function useKeepPlace(
  keys: readonly (string | number)[],
  anchorRef: RefObject<Anchor | undefined>,
  pinnedRef: RefObject<boolean>,
  restore: (index: number, offset: number) => void,
  rowOfItem: (itemId: string) => number,
) {
  const previous = useRef(keys);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = keys;
    const at = anchorRef.current;
    if (before === keys || pinnedRef.current || !at) return;
    if (keys[at.index] === at.key) return;
    let index = keys.indexOf(at.key);
    if (index < 0 && at.itemId !== undefined) index = rowOfItem(at.itemId);
    if (index < 0) return;
    anchorRef.current = { ...at, index, key: keys[index] ?? at.key };
    restore(index, at.offset);
  }, [keys, anchorRef, pinnedRef, restore, rowOfItem]);
}
