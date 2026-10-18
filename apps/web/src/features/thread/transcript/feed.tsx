import { StoppedPill } from "../long/stopped-pill.tsx";
import type { HistoryPager } from "@ace/client-react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useTopFade } from "@/lib/edge-fade.ts";
import { frameThrottle } from "@/lib/frame-throttle.ts";
import { useListMotion, usePresence } from "@/lib/motion.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";
import { LiveFrames, LiveFramesContext } from "../items/live-frames.ts";
import { usePlaceBeforePaint } from "@/lib/virtual-paint.ts";
import {
  DeferredGapRow,
  DeferredJumpFailed,
  DeferredLivePill,
  DeferredSearchBar,
  DeferredTurnKeys,
  DeferredTurnRail,
} from "../deferred.ts";
import { BlockView } from "../items/block-view.tsx";
import { JumpedItem } from "../items/jumped-item.ts";
import { DeferredHeldSend } from "../composer/deferred-parts.tsx";
import { readingColumn } from "../lib/column.ts";
import type { JumpSnapshot } from "../long/jump-controller.ts";
import type { ThreadNav } from "../long/nav.tsx";
import type { Block } from "./blocks.ts";
import { useDropTurnSteps } from "../lib/turn-steps.ts";
import { rowOf, sameRow, transcriptRows, type Row } from "./rows.ts";
import { useGutter } from "./scroll.ts";
import { useFeedScroll, useThreadScrolls, writeScroll } from "./use-feed-scroll.ts";
import { rowGap } from "./row-gap.ts";
import { useHistoryPaging, usePagingIntent } from "./use-history-paging.ts";
import { useRunOrdinals } from "./run-ordinals.ts";
import { useBlocks } from "./use-blocks.ts";
import { useTurnActivity } from "./use-turn-activity.ts";
import { useReadMarker } from "./seen.ts";
import { AgentPageReveal } from "./agent-page-reveal.tsx";

const tailLive: Block = { kind: "live", key: "live:tail", askId: undefined };
/** First guess for an unmeasured row's height; measured sizes replace it per row key. */
const estimatedRowSize = 96;
/** Room above a row brought into view, for the search bar floating over the transcript's top. */
const topRoom = 12;
const now = () => performance.now();
const rowKey = (row: Row) => row.key;
/** The turn of the first row from `index` that knows its turn. */
function turnFrom(rows: readonly Row[], index: number): number | undefined {
  for (let at = index; at < Math.min(rows.length, index + 8); at++) {
    const ordinal = rows[at]?.ordinal;
    if (ordinal !== undefined) return ordinal;
  }
  return undefined;
}
/** The rows' keys, the same array while they are the same keys (the virtualizer's sizes key on them). */
function useStableKeys(rows: readonly Row[]): readonly string[] {
  const [keys, setKeys] = useState<readonly string[]>(() => rows.map(rowKey));
  const same = keys.length === rows.length && rows.every((row, index) => row.key === keys[index]);
  if (same) return keys;
  const next = rows.map(rowKey);
  setKeys(next);
  return next;
}
const highlight = {
  boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 45%, transparent)",
  borderRadius: 12,
  transition: "box-shadow var(--motion-slow) var(--ease-out)",
};

export interface FeedProps {
  threadId: string;
  nav: ThreadNav;
  jump: JumpSnapshot;
  pager: HistoryPager;
  /** Jumped windows' items' turns, from the turn index. */
  seqTurns: ReadonlyMap<string, number> | undefined;
  /** Items that reached the live end since the reader left it. */
  fresh: { count: number; more: boolean };
}

/**
 * The virtualized rows of the transcript (live tail or a jumped window, through the window
 * provider), with the bars that float over it. The compiler skips this component (the
 * virtualizer's callbacks are unstable by design); the rows it renders are compiled.
 */
export function Feed(props: FeedProps) {
  const { threadId, nav, jump, pager } = props;
  useReadMarker(threadId, nav);
  const window = jump.window;
  const detached = !!window && !jump.joined;
  // Only the daemon's items: a message still on its way is in the composer's strip.
  const built = useBlocks(threadId);
  const activity = useTurnActivity(threadId);
  useDropTurnSteps(threadId);
  // The live turn's one status line heads its flow, under its ask; a turn with no block in view
  // yet (its ask still on its way, older than the window) keeps it at the end of the rows. Either way it is
  // one row, which moves rather than flashing out and back in.
  const working = !detached && !!activity && activity.tone !== "paused";
  const blocks = useMemo(
    () => (working && !built.some((block) => block.kind === "live") ? [...built, tailLive] : built),
    [built, working],
  );
  const runOrdinals = useRunOrdinals(threadId);
  const { seqTurns } = props;
  const ordinalOf = useCallback(
    (id: string) => runOrdinals.get(id) ?? seqTurns?.get(id),
    [runOrdinals, seqTurns],
  );
  const handled = useRef(0);
  const focus = jump.focus;
  const rows = useMemo(() => transcriptRows(blocks, ordinalOf), [blocks, ordinalOf]);
  const keys = useStableKeys(rows);
  const { rows: motionRows } = useListMotion(rows, rowKey);
  const entering = useMemo(
    () => new Set(motionRows.flatMap((row) => (row.phase === "enter" ? [row.key] : []))),
    [motionRows],
  );

  const viewport = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ key: string; hit: boolean }>();

  // A row filling in (its text, a card's code arriving) moves the rows under it in the same
  // frame, so a thread never paints its rows stacked on each other.
  const placed = usePlaceBeforePaint<HTMLDivElement, Element>();
  // Where the reader left this thread, and its rows' sizes then, so it reopens there (a link
  // to an item or an open window goes where it points instead).
  const threadScrolls = useThreadScrolls();
  const [left] = useState(() => {
    const saved = detached || focus ? undefined : threadScrolls.peek(threadId);
    return { saved, measured: saved ? [...saved.measured] : [] };
  });
  // Part of the virtualizer's measurement memo: a new function would rebuild every row's
  // measurement on every render.
  const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);
  // oxlint-disable-next-line react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    measureElement: placed.measureElement,
    onChange: placed.onChange,
    getScrollElement: () => viewport.current,
    estimateSize: () => estimatedRowSize,
    // Rows are tall (a message, a log): a generous overscan keeps fast upward
    // flicks covered so older history measures before it scrolls into view.
    overscan: 12,
    // Scroll-driven range changes render with the next update rather than synchronously in
    // the scroll event: one commit per frame however many scroll events it brings.
    useFlushSync: false,
    scrollMargin: feed.current?.offsetTop ?? 0,
    scrollPaddingStart: topRoom,
    getItemKey,
    initialMeasurementsCache: left.measured,
    scrollToFn: writeScroll,
    // A jump must measure its target even when estimated sizes initially place
    // it outside the viewport. Retain only that one row alongside the visible
    // range; the next jump or return to live replaces or clears the focus.
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range);
      const target = focus ? rowOf(rows, focus.itemId) : -1;
      return target < 0 || visible.includes(target)
        ? visible
        : [...visible, target].toSorted((a, b) => a - b);
    },
  });
  useForgetGoneRows(virtualizer, rows.length, getItemKey);
  const total = virtualizer.getTotalSize();
  const margin = virtualizer.options.scrollMargin;

  const intent = usePagingIntent(now);
  const scroll = useFeedScroll({
    viewport,
    virtualizer,
    rows,
    keys,
    total,
    detached,
    topRoom,
    dock,
    now,
    onDirection: intent.onDirection,
    restore: left.saved,
    remember: (saved) => threadScrolls.save(threadId, saved),
  });
  const pinned = scroll.following;
  const paging = useHistoryPaging({
    intent,
    viewport,
    pager,
    jump,
    nav,
    detached,
    following: pinned,
  });
  useGutter(viewport);
  // Leaving a window (back to live, or a link that failed) shows the live tail from its end,
  // never from the top, where it would page older history in.
  const hadWindow = useRef(!!window);
  useLayoutEffect(() => {
    const had = hadWindow.current;
    hadWindow.current = !!window;
    if (!had || window || scroll.isFollowing()) return;
    scroll.toLive("now");
  }, [window, scroll]);
  useEffect(() => nav.following.set(pinned && !window), [nav.following, pinned, window]);
  // A joined window the reader follows past is no longer needed: back to the tail alone.
  useEffect(() => {
    if (!window || !jump.joined || !pinned) return;
    const timer = setTimeout(() => nav.jump.live(), 1_500);
    return () => clearTimeout(timer);
  }, [nav.jump, window, jump.joined, pinned]);

  /** The first row in view, and which turns the reader sees, top to bottom. */
  const readTop = () => {
    const first = scroll.observe();
    if (!first) return;
    const topTurn = turnFrom(rows, first.index);
    if (topTurn !== undefined) nav.currentTurn.set(topTurn);
    const el = viewport.current;
    const fold = el ? el.scrollTop + el.clientHeight : undefined;
    const last =
      fold === undefined
        ? undefined
        : virtualizer.getVirtualItems().findLast((item) => item.start < fold);
    // Rows carry their turn forward, so the last row in view names the bottom turn.
    const bottomTurn = last ? rows[last.index]?.ordinal : undefined;
    nav.bottomTurn.set(bottomTurn ?? topTurn);
  };
  // Read at most once a frame while scrolling, and once after the rows change; never after
  // every render (a measuring pass re-renders this many times a second while text streams).
  const latestReadTop = useRef(readTop);
  useLayoutEffect(() => {
    latestReadTop.current = readTop;
  });
  const [topReader] = useState(() => frameThrottle(() => latestReadTop.current()));
  useEffect(() => () => topReader.cancel(), [topReader]);
  useEffect(() => latestReadTop.current(), [keys, total]);

  // A jump (or a search hit) brings its item into view once its row exists, and holds it there
  // while its neighbours measure, until the reader scrolls (see `scroll-mode.ts`).
  useLayoutEffect(() => {
    if (!focus || handled.current === focus.nonce) return;
    const index = rowOf(rows, focus.itemId);
    if (index < 0) return;
    handled.current = focus.nonce;
    scroll.jumpTo(index, focus.query ? "center" : "start", focus.itemId);
    const key = rows[index]?.key;
    if (key) setFlash({ key, hit: focus.query !== undefined });
  }, [focus, rows, scroll]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 1_600);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    if (!nav.searchOpen) setFlash(undefined);
  }, [nav.searchOpen]);
  const items = virtualizer.getVirtualItems();
  const { hasOlder, loading, loadOlder } = pager;
  const toLive = () => {
    paging.reset();
    scroll.toLive(window ? undefined : "glide");
    if (window) nav.jump.live();
  };

  const lastWindowOrdinal = window ? ordinalOf(window.items.at(-1)?.id ?? "") : undefined;
  // The floating controls stay mounted through their exit. There is deliberately
  // no "viewing history" bar at the top: older history is one continuous list,
  // and the live pill alone offers the way back to the live end.
  const livePill = usePresence(!pinned || detached);
  const fadeTop = useTopFade(viewport);
  // At most four chat visualizations hold a live page at once (each runs its own scripts).
  const [liveFrames] = useState(() => new LiveFrames(4));
  return (
    <LiveFramesContext value={liveFrames}>
      <div className="relative flex h-full min-h-0 flex-col">
        {/* The rows and the search bar floating over their top. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <Suspense fallback={null}>
            <DeferredTurnRail.Component nav={nav} scroller={viewport} />
          </Suspense>
          <div
            ref={viewport}
            data-virtual-viewport=""
            // A classic scrollbar reserves the same room on both edges, so the column stays centred
            // on the composer's axis; `useGutter` gives the composer the same inset.
            // Once scrolled, the top 16px fade, so nothing reads as cut under the header.
            style={fadeTop ? { maskImage: fadeTop, WebkitMaskImage: fadeTop } : undefined}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
            onScroll={(event) => {
              const el = event.currentTarget;
              topReader.request();
              paging.onScroll(el);
              scroll.scrolled(el);
            }}
          >
            <div
              className={`${readingColumn} relative pt-6 pb-[calc(var(--composer-clearance,0px)+4rem)]`}
            >
              {/* Over the top padding, never above the rows: older history's arrival moves nothing. */}
              {hasOlder && loading && (
                <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center">
                  <span role="status" aria-label="Loading earlier messages">
                    <Spinner />
                  </span>
                </div>
              )}
              {pager.error && (
                <p role="alert" className="pb-3 text-center text-xs text-status-failed">
                  Couldn't load earlier messages. Try again.
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => void loadOlder()}
                  >
                    Try again
                  </Button>
                </p>
              )}
              <div
                ref={feed}
                role="feed"
                aria-label="Transcript"
                aria-busy={loading || jump.loading !== undefined}
                className="relative w-full"
                style={{ height: total }}
              >
                <JumpedItem value={focus?.itemId}>
                  {items.map((item) => {
                    const row = rows[item.index];
                    if (!row) return null;
                    const lit = flash?.key === row.key;
                    return (
                      <div
                        key={item.key}
                        ref={virtualizer.measureElement}
                        data-index={item.index}
                        role="article"
                        aria-posinset={item.index + 1}
                        aria-setsize={hasOlder ? -1 : rows.length}
                        {...(lit && flash?.hit ? { "data-hit": "" } : {})}
                        className={cn(
                          "absolute inset-x-0 top-0",
                          rowGap(row, rows[item.index + 1]),
                        )}
                        style={{ transform: `translateY(${item.start - margin}px)` }}
                      >
                        <div
                          className={entering.has(row.key) ? "fx-rise-in" : undefined}
                          style={lit ? highlight : undefined}
                        >
                          <RowView threadId={threadId} row={row} live={false} />
                        </div>
                      </div>
                    );
                  })}
                </JumpedItem>
              </div>
              {detached && (
                <Suspense fallback={null}>
                  <DeferredGapRow.Component
                    threadId={threadId}
                    lastTurn={lastWindowOrdinal}
                    loading={jump.loading === "newer"}
                    onNewer={() => void nav.jump.newer()}
                    onLive={toLive}
                  />
                </Suspense>
              )}
              <div ref={dock} className="mt-4 empty:hidden" />
              {!detached && (
                <Suspense fallback={null}>
                  <DeferredHeldSend.Component threadId={threadId} />
                  <AgentPageReveal threadId={threadId} />
                </Suspense>
              )}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[6] flex flex-col items-center gap-2 px-4">
            {nav.searchOpen && (
              <Suspense fallback={null}>
                <DeferredSearchBar.Component nav={nav} />
              </Suspense>
            )}
            {jump.failed && (
              <Suspense fallback={null}>
                <DeferredJumpFailed.Component
                  message={jump.failed}
                  onDismiss={() => nav.jump.dismissError()}
                />
              </Suspense>
            )}
          </div>
        </div>
        <Suspense fallback={null}>
          <DeferredTurnKeys.Component
            rows={rows}
            top={scroll.top}
            nav={nav}
            scrollTo={(index) => {
              // A turn key jumps the view: where it lands is no gesture toward history.
              paging.reset();
              scroll.jumpTo(index, "start");
            }}
            toLive={toLive}
          />
        </Suspense>
        {livePill.mounted && (
          <Suspense fallback={null}>
            <DeferredLivePill.Component
              phase={livePill.phase}
              newItems={props.fresh.count}
              more={props.fresh.more}
              paused={activity?.tone === "working"}
              onClick={toLive}
            />
          </Suspense>
        )}
        <StoppedPill threadId={threadId} raised={livePill.mounted} />
      </div>
    </LiveFramesContext>
  );
}

interface RowViewProps {
  threadId: string;
  row: Row;
  live: boolean;
}
/** Rows are rebuilt when blocks change (history paging in); an unchanged row draws nothing. */
const sameRowView = (a: RowViewProps, b: RowViewProps) =>
  a.threadId === b.threadId && a.live === b.live && sameRow(a.row, b.row);

const RowView = memo(function RowView(props: RowViewProps) {
  return (
    <BlockView
      threadId={props.threadId}
      block={props.row.block}
      live={props.live}
      ordinal={props.row.ordinal}
    />
  );
}, sameRowView);
