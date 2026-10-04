import { nextFrame } from "./next-frame.ts";

/** A root margin edge that pulls the viewport's edge in to `value` pixels from it. */
const inset = (value: number) => `${-Math.max(0, Math.floor(value))}px`;

/**
 * Calls back with an element's box in the viewport whenever it changes: a resize of the
 * element or the window, a scroll, and a move without a resize (a sidebar collapsing beside
 * it). Changes are coalesced to one read per frame, and nothing runs while nothing moves.
 *
 * A move is caught by an IntersectionObserver whose root margin shrinks the viewport to the
 * element's current box: the element then fills its root exactly, and the slightest move
 * changes how much of it intersects.
 */
export function observeRect(
  element: Element,
  onChange: (rect: DOMRectReadOnly) => void,
): () => void {
  let last = "";
  let cancel: (() => void) | undefined;
  let moves: IntersectionObserver | undefined;

  const watchMoves = (rect: DOMRectReadOnly) => {
    moves?.disconnect();
    moves = undefined;
    if (typeof IntersectionObserver === "undefined" || rect.width <= 0 || rect.height <= 0) return;
    const root = document.documentElement;
    const margin = [
      inset(rect.top),
      inset(root.clientWidth - rect.right),
      inset(root.clientHeight - rect.bottom),
      inset(rect.left),
    ].join(" ");
    let first: number | undefined;
    moves = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (first === undefined) first = entry.intersectionRatio;
        else if (entry.intersectionRatio !== first) schedule();
      },
      { rootMargin: margin, threshold: Array.from({ length: 101 }, (_, index) => index / 100) },
    );
    moves.observe(element);
  };

  const measure = () => {
    cancel = undefined;
    const rect = element.getBoundingClientRect();
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (key === last) return;
    last = key;
    watchMoves(rect);
    onChange(rect);
  };
  const schedule = () => {
    cancel ??= nextFrame(measure);
  };

  const resizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  resizes?.observe(element);
  addEventListener("resize", schedule);
  addEventListener("scroll", schedule, { capture: true, passive: true });
  measure();
  return () => {
    cancel?.();
    resizes?.disconnect();
    moves?.disconnect();
    removeEventListener("resize", schedule);
    removeEventListener("scroll", schedule, { capture: true });
  };
}
