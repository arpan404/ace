import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { readingColumn } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useMarkSeen, type SeenTarget } from "./use-mark-seen.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/* What a bot's and a group's screens share: the scroller, the loading shape, a problem line. */

/** Spade's state line on this window's machine. */
export function useSpadeLine() {
  const [enabled] = useSpadeEnabled();
  return spadeStateLine(useSpadeStatus(), enabled);
}

const scrollerClass =
  "col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]";

/** The reading column, with room under the last line for the composer floating over it. */
const columnClass = cn(readingColumn, "w-full pb-[calc(var(--composer-clearance,0px)+1rem)]");

/**
 * A page over the composer that isn't a conversation yet (New bot): it opens at its top, so the
 * head is in view, and stays wherever the person scrolls it while its rows load.
 */
export function PageScroller(props: { children: ReactNode }) {
  return (
    <div className={scrollerClass}>
      <div className={cn(columnClass, "pt-6")}>{props.children}</div>
    </div>
  );
}

function pinToEnd(element: HTMLElement | null, atEnd: boolean) {
  if (element && atEnd) element.scrollTop = element.scrollHeight;
}

/**
 * A scroller that stays at its end while the person is there, as the conversation grows: on
 * every render and whenever the content's height changes after it. A short conversation starts
 * at the top. With `seen`, being at the end marks the conversation seen (`useMarkSeen`).
 */
export function Scroller(props: {
  /** What floats over its top: the pill of a bot's conversation, which the first line clears. */
  top?: "pill" | undefined;
  seen?: SeenTarget | undefined;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const reportEnd = useMarkSeen(props.seen);
  useLayoutEffect(() => pinToEnd(scroller.current, atEnd.current));
  // It opens at its end.
  useEffect(() => reportEnd(atEnd.current), [reportEnd]);
  useLayoutEffect(() => {
    const inner = content.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pinToEnd(scroller.current, atEnd.current));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        reportEnd(atEnd.current);
      }}
      className={scrollerClass}
    >
      <div ref={content} className={cn(columnClass, props.top === "pill" ? "pt-18" : "pt-6")}>
        {props.children}
      </div>
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <LoadingRegion label="Conversation" className="flex flex-col gap-3">
      <Skeleton className="ml-auto h-9 w-48 rounded-lg" />
      <Skeleton className="h-14 w-3/4 rounded-lg" />
    </LoadingRegion>
  );
}

export function Problem(props: { text: string; onRetry(): void }) {
  return (
    <div role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
      <span className="min-w-0 flex-1">{props.text}</span>
      <Button size="xs" variant="ghost" onClick={props.onRetry}>
        Try again
      </Button>
    </div>
  );
}

export const message = (error: unknown) => (error instanceof Error ? error.message : "Try again.");
