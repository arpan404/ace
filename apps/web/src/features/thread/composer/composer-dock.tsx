import { useCallback, type ReactNode, type Ref } from "react";
import { readingColumn } from "../lib/column.ts";

const composerInset = {
  paddingLeft: "var(--transcript-gutter)",
  paddingRight: "calc(var(--transcript-gutter) + var(--summary-inset, 0px))",
};

/**
 * Floating over the transcript on its reading column. A pinned summary beside the text insets
 * it (`--summary-inset`), so their edges still agree. Only the glass surfaces catch pointer
 * events; the gaps leave the transcript available for scrolling and selection.
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
      const measure = () =>
        column?.style.setProperty(
          "--composer-clearance",
          `${element.getBoundingClientRect().height}px`,
        );
      measure();
      const observer =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
      observer?.observe(element);
      return () => {
        observer?.disconnect();
        column?.style.removeProperty("--composer-clearance");
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
      className="pointer-events-none relative z-10 col-start-1 row-start-1 w-full self-end pb-4"
    >
      <div data-composer-area className={`pointer-events-auto relative ${readingColumn}`}>
        {children}
      </div>
    </div>
  );
}
