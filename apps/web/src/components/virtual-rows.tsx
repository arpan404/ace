import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/*
 * Rows of a long list mounted only while near the viewport of whatever ancestor scrolls (a
 * panel, a page), so a 100,000-line diff mounts a screenful. Visible rows stay in normal flow
 * between two spacers, so wide rows still widen their container and scroll sideways.
 */

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Offset of `element` from the top of `parent`'s scrolled content. */
function offsetWithin(element: HTMLElement, parent: HTMLElement): number {
  return (
    element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop
  );
}

export function VirtualRows<T>(props: {
  items: readonly T[];
  rowKey(item: T, index: number): string;
  /** Typical row height in px; rows are measured once mounted. */
  estimate: number;
  render(item: T, index: number): ReactNode;
  overscan?: number;
}) {
  const { items, rowKey, estimate, render } = props;
  const box = useRef<HTMLDivElement>(null);
  const [parent, setParent] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    const found = scrollParent(element);
    if (!element || !found) return;
    const measure = () => setMargin(offsetWithin(element, found));
    // Finding the scroll ancestor needs the mounted DOM; one extra layout pass at mount.
    // oxlint-disable-next-line react-compiler/set-state-in-effect
    setParent(found);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Content above the rows (a file collapsing) moves them; so does the scroller resizing.
    const observer = new ResizeObserver(measure);
    observer.observe(found);
    if (found.firstElementChild) observer.observe(found.firstElementChild);
    return () => observer.disconnect();
  }, []);
  // The compiler skips this component (the virtualizer's callbacks are unstable by design).
  // oxlint-disable-next-line react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent,
    estimateSize: () => estimate,
    overscan: props.overscan ?? 24,
    scrollMargin: margin,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : rowKey(item, index);
    },
  });
  const rows = virtualizer.getVirtualItems();
  const first = rows[0];
  const last = rows.at(-1);
  const before = first ? first.start - margin : 0;
  const after = last ? virtualizer.getTotalSize() - (last.end - margin) : 0;
  return (
    <div ref={box}>
      <div aria-hidden style={{ height: Math.max(0, before) }} />
      {rows.map((row) => {
        const item = items[row.index];
        return item === undefined ? null : (
          <div key={row.key} data-index={row.index} ref={virtualizer.measureElement}>
            {render(item, row.index)}
          </div>
        );
      })}
      <div aria-hidden style={{ height: Math.max(0, after) }} />
    </div>
  );
}
