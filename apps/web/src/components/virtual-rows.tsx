import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Fragment,
  useImperativeHandle,
  type AriaRole,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";

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

/** Brings a row into view whether or not it is mounted: to the top, or just enough to show it. */
export interface VirtualRowsHandle {
  scrollToIndex(index: number, align?: "start" | "auto"): void;
}

export interface VirtualRowsProps<T> {
  items: readonly T[];
  rowKey(item: T, index: number): string;
  /** Typical row height in px (or per row); rows are measured once mounted. */
  estimate: number | ((item: T, index: number) => number);
  render(item: T, index: number): ReactNode;
  /** Rows mounted beyond each edge of the viewport. Small by default: each costs a render. */
  overscan?: number;
  handle?: Ref<VirtualRowsHandle>;
  /** The rows as a list for assistive tech: its name, and each row's role (a listitem by default). */
  list?: { label: string; rowRole?(item: T, index: number): AriaRole };
  /**
   * Mount every row while there are at most this many (no measuring), only those near the
   * viewport past it. The rows stay the same elements either way, so focus survives the change.
   */
  virtualAbove?: number;
}

export function VirtualRows<T>(props: VirtualRowsProps<T>) {
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
    // Inside a row of the transcript (a long block), only that row: watching the whole
    // transcript would re-measure on every resize of every row while text streams. Rows above
    // it move it by scrolling (the transcript compensates), so a scroll re-measures too.
    const row = found.matches("[data-virtual-viewport]")
      ? element.closest<HTMLElement>("[data-index]")
      : null;
    const own = row && found.contains(row) ? row : undefined;
    const content = own ?? found.firstElementChild;
    if (content) observer.observe(content);
    if (own) found.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      found.removeEventListener("scroll", measure);
    };
  }, []);
  const all = items.length <= (props.virtualAbove ?? -1);
  // The compiler skips this component (the virtualizer's callbacks are unstable by design).
  // oxlint-disable-next-line react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    // Every row mounted: nothing to follow while scrolling.
    enabled: !all,
    count: items.length,
    getScrollElement: () => parent,
    estimateSize: (index) => {
      if (typeof estimate === "number") return estimate;
      const item = items[index];
      return item === undefined ? 0 : estimate(item, index);
    },
    overscan: props.overscan ?? 8,
    scrollMargin: margin,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : rowKey(item, index);
    },
  });
  useForgetGoneRows(virtualizer, items.length, (index) => {
    const item = items[index];
    return item === undefined ? index : rowKey(item, index);
  });
  useImperativeHandle(
    props.handle,
    () => ({
      scrollToIndex: (index, align = "start") => {
        if (!all) return virtualizer.scrollToIndex(index, { align });
        box.current
          ?.querySelector(`:scope > [data-index="${index}"]`)
          ?.scrollIntoView?.({ block: align === "auto" ? "nearest" : "start" });
      },
    }),
    [virtualizer, all],
  );
  const rows = all
    ? items.map((item, index) => ({ index, key: rowKey(item, index), start: 0, end: 0 }))
    : virtualizer.getVirtualItems();
  const first = rows[0];
  const last = rows.at(-1);
  const before = first && !all ? first.start - margin : 0;
  const after = last && !all ? virtualizer.getTotalSize() - (last.end - margin) : 0;
  const list = props.list;
  return (
    <div ref={box} role={list && "list"} aria-label={list?.label}>
      <div aria-hidden style={{ height: Math.max(0, before) }} />
      {rows.map((row) => {
        const item = items[row.index];
        return item === undefined ? null : (
          <div
            key={row.key}
            data-index={row.index}
            role={list && (list.rowRole?.(item, row.index) ?? "listitem")}
            ref={all ? undefined : virtualizer.measureElement}
          >
            {render(item, row.index)}
          </div>
        );
      })}
      <div aria-hidden style={{ height: Math.max(0, after) }} />
    </div>
  );
}

/**
 * A list that is usually short but can grow without bound (a log, a terminal screen, a diff):
 * every row while it has at most `virtualAbove` of them, only the rows near the viewport past
 * that. Short lists skip the virtualizer's measuring; long ones never mount thousands of rows.
 */
export function LongRows<T>(props: VirtualRowsProps<T> & { virtualAbove: number }) {
  const { virtualAbove, ...rows } = props;
  if (props.items.length > virtualAbove) return <VirtualRows {...rows} />;
  return props.items.map((item, index) => (
    <Fragment key={props.rowKey(item, index)}>{props.render(item, index)}</Fragment>
  ));
}

/**
 * A list of rows (a panel's, a page's) that can grow without bound: every row while it has at
 * most `virtualAbove`, only those near the viewport past that. Each row is a listitem box marked
 * with its `data-index`, so keyboard focus (`useViewListKeys`) finds rows the same way whether
 * or not they are all mounted, and `handle` brings any row into view.
 */
export function VirtualList<T>(
  props: Omit<VirtualRowsProps<T>, "list"> & {
    label: string;
    rowRole?(item: T, index: number): AriaRole;
  },
) {
  const { label, rowRole, virtualAbove = 100, ...rows } = props;
  return (
    <VirtualRows
      {...rows}
      virtualAbove={virtualAbove}
      list={{ label, ...(rowRole ? { rowRole } : {}) }}
    />
  );
}
