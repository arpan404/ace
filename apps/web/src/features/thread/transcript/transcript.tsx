import { useHistoryPager, useItemOrder } from "@ace/client-react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { BlockView } from "../items/block-view.tsx";
import type { Block } from "./blocks.ts";
import { LiveFooter } from "./live-footer.tsx";
import { useBlocks } from "./use-blocks.ts";
import { useNewActivity } from "./use-new-activity.ts";

const none: readonly string[] = [];
const nearEdge = 64;
const gap: Record<Block["kind"], string> = {
  user: "pb-7",
  message: "pb-4",
  work: "pb-2.5",
  files: "pb-4",
  subagents: "pb-1.5",
  background: "pb-2",
  item: "pb-3",
};

/**
 * The reading column: a virtualized feed of transcript blocks over the client's bounded item
 * window (ADR 0006). Older history pages in at the top, keeping the reader's place; new output
 * is followed while the reader is at the bottom, and a button brings them back otherwise.
 */
export function Transcript(props: { threadId: string }) {
  const blocks = useBlocks(props.threadId);
  const order = useItemOrder(props.threadId) ?? none;
  const pager = useHistoryPager(props.threadId);
  const divider = useNewActivity(props.threadId, blocks, order);
  const viewport = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // React Compiler is not used; the virtualizer's unstable callbacks are fine here.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 96,
    overscan: 8,
    scrollMargin: feed.current?.offsetTop ?? 0,
    getItemKey: (index) => blocks[index]?.key ?? index,
  });
  const total = virtualizer.getTotalSize();
  const scrollToEnd = () => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useKeepPlace(blocks, virtualizer.scrollToIndex);
  // Follow streaming output and new blocks while the reader is at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToEnd();
  }, [total, blocks]);

  const rows = virtualizer.getVirtualItems();
  const firstVisible = rows[0]?.index;
  const { hasOlder, loading, loadOlder } = pager;
  useEffect(() => {
    if (firstVisible === 0 && hasOlder && !loading && !pinnedRef.current) void loadOlder();
  }, [firstVisible, hasOlder, loading, loadOlder]);
  const margin = virtualizer.options.scrollMargin;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={viewport}
        data-virtual-viewport=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const el = event.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < nearEdge;
          pinnedRef.current = atEnd;
          setPinned(atEnd);
        }}
      >
        <div className="mx-auto w-full max-w-(--column) px-8 pt-6 pb-10">
          <div className="flex justify-center pb-4">
            {hasOlder ? (
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void loadOlder()}>
                {loading && <Spinner />}
                Load earlier messages
              </Button>
            ) : (
              <Marker variant="separator" className="text-xs text-subtle-foreground">
                <MarkerContent>Beginning of thread</MarkerContent>
              </Marker>
            )}
          </div>
          {pager.error && (
            <p role="alert" className="pb-3 text-center text-xs text-status-failed">
              Couldn't load earlier messages. Try again.
            </p>
          )}
          <div
            ref={feed}
            role="feed"
            aria-label="Transcript"
            aria-busy={loading}
            className="relative w-full"
            style={{ height: total }}
          >
            {rows.map((row) => {
              const block = blocks[row.index];
              if (!block) return null;
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  role="article"
                  aria-posinset={row.index + 1}
                  aria-setsize={hasOlder ? -1 : blocks.length}
                  className={cn("absolute inset-x-0 top-0", gap[block.kind])}
                  style={{ transform: `translateY(${row.start - margin}px)` }}
                >
                  {divider === block.key && <NewActivity />}
                  <BlockView threadId={props.threadId} block={block} />
                </div>
              );
            })}
          </div>
          <LiveFooter threadId={props.threadId} />
        </div>
      </div>
      {!pinned && (
        <button
          type="button"
          onClick={() => {
            pinnedRef.current = true;
            setPinned(true);
            virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
            scrollToEnd();
          }}
          className="glass absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowDownIcon aria-hidden size={14} />
          Scroll to latest
        </button>
      )}
    </div>
  );
}

function NewActivity() {
  return (
    <div
      role="separator"
      aria-label="New activity"
      className="mt-2 mb-6 flex items-center gap-3 text-xs font-medium tracking-[0.01em] text-[color-mix(in_oklab,var(--ring)_80%,var(--foreground))] before:h-px before:flex-1 before:bg-[color-mix(in_oklab,var(--ring)_28%,transparent)] after:h-px after:flex-1 after:bg-[color-mix(in_oklab,var(--ring)_28%,transparent)]"
    >
      New activity
    </div>
  );
}

/** After older history is prepended, keep the block the reader was looking at in place. */
function useKeepPlace(
  blocks: readonly Block[],
  scrollToIndex: (index: number, options: { align: "start" | "end" }) => void,
) {
  const first = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const before = first.current;
    first.current = blocks[0]?.key;
    if (before === undefined) return;
    const shifted = blocks.findIndex((block) => block.key === before);
    if (shifted > 0) scrollToIndex(shifted, { align: "start" });
  }, [blocks, scrollToIndex]);
}
