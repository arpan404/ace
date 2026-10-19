import { useEffect, useRef, type RefObject } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

/** How far below the viewport the next page starts loading. */
const ahead = "800px 0px";

/**
 * The end of the file list. Scrolled near, it asks for the next page (each page loaded re-arms
 * it, so a short page keeps going); a failed page shows an inline Retry. Without an
 * IntersectionObserver (tests) every page is asked for at once.
 */
export function PrMoreFiles(props: {
  state: "idle" | "loading" | "failed" | "done";
  /** Pages loaded so far. */
  loaded: number;
  root: RefObject<HTMLElement | null>;
  onMore(): void;
  onRetry(): void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { state, loaded, root, onMore } = props;
  useEffect(() => {
    if (state !== "idle") return;
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      onMore();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore();
      },
      { root: root.current, rootMargin: ahead },
    );
    observer.observe(element);
    return () => observer.disconnect();
    // `loaded` re-arms the observer: a page that left the sentinel in view asks for the next.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [state, loaded, root, onMore]);
  if (state === "done") return null;
  return (
    <div
      ref={sentinel}
      className="flex min-h-10 items-center gap-2 px-3.5 text-xs text-subtle-foreground"
    >
      {state === "failed" ? (
        <div role="alert" className="flex items-center gap-2">
          <span>The rest of this diff couldn't load.</span>
          <Button size="xs" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <Spinner />
          <span role="status">Loading more files…</span>
        </>
      )}
    </div>
  );
}
