import { useHistoryPager, useItemOrder } from "@ace/client-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { TranscriptItem } from "./items/transcript-item.tsx";

const none: readonly string[] = [];
const nearEdge = 64;

/**
 * Virtualized transcript over the client's bounded item window (ADR 0006). Only visible rows
 * mount; older history loads by page when the reader reaches the top, keeping their place.
 */
export function Transcript(props: { threadId: string }) {
  const order = useItemOrder(props.threadId) ?? none;
  const pager = useHistoryPager(props.threadId);
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // React Compiler is not used; the virtualizer's unstable callbacks are fine here.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => order[index] ?? index,
  });
  useKeepPlace(order, virtualizer.scrollToIndex, pinned);

  const items = virtualizer.getVirtualItems();
  const firstVisible = items[0]?.index;
  const { hasOlder, loading, loadOlder } = pager;
  useEffect(() => {
    if (firstVisible === 0 && hasOlder && !loading && !pinned.current) void loadOlder();
  }, [firstVisible, hasOlder, loading, loadOlder]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-center border-b px-3 py-1.5">
        {hasOlder ? (
          <Button variant="ghost" size="xs" disabled={loading} onClick={() => void loadOlder()}>
            {loading && <Spinner />}
            Load earlier messages
          </Button>
        ) : (
          <Marker variant="separator" className="text-xs">
            <MarkerContent>Beginning of thread</MarkerContent>
          </Marker>
        )}
      </div>
      {pager.error && (
        <p role="alert" className="px-3 py-1 text-xs text-status-failed">
          Couldn't load earlier messages. Try again.
        </p>
      )}
      <div
        ref={viewport}
        data-virtual-viewport=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < nearEdge;
        }}
      >
        <div
          role="feed"
          aria-label="Transcript"
          aria-busy={loading}
          className="relative mx-auto w-full max-w-3xl"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((row) => {
            const id = order[row.index];
            return id === undefined ? null : (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                role="article"
                aria-posinset={row.index + 1}
                aria-setsize={hasOlder ? -1 : order.length}
                className="absolute inset-x-0 top-0 px-4 py-2"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <TranscriptItem threadId={props.threadId} itemId={id} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Follow new output while the reader is at the bottom; keep the reader's row after a prepend. */
function useKeepPlace(
  order: readonly string[],
  scrollToIndex: (index: number, options: { align: "start" | "end" }) => void,
  pinned: { current: boolean },
) {
  const previous = useRef<{ first: string | undefined; length: number }>({
    first: undefined,
    length: 0,
  });
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { first: order[0], length: order.length };
    if (!order.length) return;
    const shifted = before.first === undefined ? -1 : order.indexOf(before.first);
    if (shifted > 0) scrollToIndex(shifted, { align: "start" });
    else if (pinned.current && order.length !== before.length)
      scrollToIndex(order.length - 1, { align: "end" });
  }, [order, scrollToIndex, pinned]);
}
