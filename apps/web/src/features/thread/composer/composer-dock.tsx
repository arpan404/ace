import { useCallback, type ReactNode, type Ref } from "react";
import { readingColumn } from "../lib/column.ts";

/*
 * The transcript's scroller keeps a scrollbar's room on both edges (`scrollbar-gutter: stable
 * both-edges`), so its reading column is that much narrower than the dock's until the column
 * reaches its widest. The dock keeps the same room (`--scrollbar-gap`, measured from that
 * scroller: nothing where scrollbars float over content), so the composer and the words above it
 * share one width.
 */
const composerInset = {
  paddingLeft: "calc(var(--transcript-gutter) + var(--scrollbar-gap, 0px))",
  paddingRight:
    "calc(var(--transcript-gutter) + var(--summary-inset, 0px) + var(--scrollbar-gap, 0px))",
};

/**
 * How far in the transcript's reading column starts from where the dock's would without any
 * gap: its scroller's reserved scrollbar room, if that narrows it, else nothing. Both columns
 * are `readingColumn`, so their left edges are compared with the dock's own gap taken back out.
 */
function scrollbarGap(column: HTMLElement | null, dock: HTMLElement): number {
  const area = dock.querySelector<HTMLElement>("[data-composer-area]");
  const text = [
    ...(column?.querySelectorAll<HTMLElement>('[class*="max-w-(--column)"]') ?? []),
  ].find((each) => !dock.contains(each));
  if (!column || !area || !text) return 0;
  const current = Number.parseFloat(column.style.getPropertyValue("--scrollbar-gap")) || 0;
  const gap = text.getBoundingClientRect().left - (area.getBoundingClientRect().left - current);
  return Math.max(0, Math.round(gap));
}

/**
 * Floating over the transcript on its reading column. A pinned summary beside the text insets
 * it (`--summary-inset`), so their edges still agree. Only the glass surfaces catch pointer
 * events; the gaps leave the transcript available for scrolling and selection. The docked Work
 * card borrows the summary inset, so this padding already holds the card's room; the shared
 * column's docked leftward shift is countered here (`left`, not a second translate, so the two
 * never race in the cascade), leaving this box on exactly the transcript's axis.
 */
export function ComposerDock({
  ref,
  children,
}: {
  ref?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}) {
  // Measuring on attachment also handles a composer arriving after the transcript has mounted.
  // The callback's cleanup removes both the observer and the column's reserved scroll room.
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const releaseRef = typeof ref === "function" ? ref(element) : undefined;
      if (ref && typeof ref !== "function") ref.current = element;
      const column = element.closest<HTMLElement>("[data-thread-column]");
      const measure = () => {
        column?.style.setProperty(
          "--composer-clearance",
          `${element.getBoundingClientRect().height}px`,
        );
        column?.style.setProperty("--scrollbar-gap", `${scrollbarGap(column, element)}px`);
      };
      measure();
      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
      observer?.observe(element);
      return () => {
        observer?.disconnect();
        column?.style.removeProperty("--composer-clearance");
        column?.style.removeProperty("--scrollbar-gap");
        if (typeof releaseRef === "function") releaseRef();
        else if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );
  return (
    <div
      ref={attach}
      data-composer-dock
      style={composerInset}
      // Its ::before fades the transcript out beneath the composer (styles/glass.css).
      className="pointer-events-none relative z-10 col-start-1 row-start-1 w-full self-end pb-4"
    >
      <div
        data-composer-area
        className={`pointer-events-auto relative ${readingColumn} [[data-work-docked]_&]:left-[calc(var(--work-reserve,0px)/2)]`}
      >
        {children}
      </div>
    </div>
  );
}
