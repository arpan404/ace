import { spadeStateLine } from "@ace/ui-core/spade-chat";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { readingColumn } from "@/features/thread/index.ts";
import { useSpadeEnabled } from "./use-spade-enabled.ts";
import { useSpadeStatus } from "./use-spade-status.ts";

/* What a bot's and a group's screens share: the scroller, the loading shape, a problem line. */

/** Spade's state line on this window's machine. */
export function useSpadeLine() {
  const [enabled] = useSpadeEnabled();
  return spadeStateLine(useSpadeStatus(), enabled);
}

function pinToEnd(element: HTMLElement | null, atEnd: boolean) {
  if (element && atEnd) element.scrollTop = element.scrollHeight;
}

/**
 * A scroller that stays at its end while the person is there, as the conversation grows: on
 * every render and whenever the content's height changes after it.
 */
export function Scroller(props: {
  children: ReactNode;
  /** Pinned at the top while the conversation scrolls under it: the computer's live tile. */
  pinned?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => pinToEnd(scroller.current, atEnd.current));
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
      }}
      className="col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]"
    >
      {props.pinned && (
        <div className={`${readingColumn} sticky top-0 z-10 w-full bg-background pt-3`}>
          {props.pinned}
        </div>
      )}
      {/* Room under the last line for the composer floating over the conversation. */}
      <div
        ref={content}
        className={`${readingColumn} mt-auto w-full pt-6 pb-[calc(var(--composer-clearance,0px)+1rem)]`}
      >
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
