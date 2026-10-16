import { StoppedPill } from "../long/stopped-pill.tsx";
import { listenScrollIntent } from "./scroll-intent.ts";
import { useThreadStore, type HistoryPager } from "@ace/client-react";
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
import { scrollToEnd as glideToEnd, useListMotion, usePresence } from "@/lib/motion.ts";
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
import { DeferredHeldSend, DeferredLocalSends } from "../composer/deferred-parts.tsx";
import { useLocalSendsView } from "../composer/send-store.ts";
import { readingColumn } from "../lib/column.ts";
import type { JumpSnapshot } from "../long/jump-controller.ts";
import type { ThreadNav } from "../long/nav.tsx";
import { blockItems, type Block } from "./blocks.ts";
import { LiveHead } from "../items/live-head.tsx";
import { useDropTurnSteps } from "../lib/turn-steps.ts";
import { rowOf, sameRow, transcriptRows, type Row } from "./rows.ts";
import { useDockShift, useGutter, useKeepPlace, useStayPinned, type Anchor } from "./scroll.ts";
import { useRunOrdinals } from "./run-ordinals.ts";
import { useBlocks } from "./use-blocks.ts";
import { useTurnActivity } from "./use-turn-activity.ts";
import { useReadMarker } from "./seen.ts";
import { AgentPageReveal } from "./agent-page-reveal.tsx";

const nearEdge = 64;
const tailLive: Block = { kind: "live", key: "live:tail", askId: undefined };
/** First guess for an unmeasured row's height; measured sizes replace it per row key. */
const estimatedRowSize = 96;
/** Room above a row brought into view, for the search bar floating over the transcript's top. */
const topRoom = 12;
const gap: Record<Block["kind"], string> = {
  user: "pb-4",
  message: "pb-4",
  work: "pb-2.5",
  live: "pb-1.5",
  thinking: "pb-2",
  files: "pb-4",
  subagents: "pb-1.5",
  background: "pb-2",
  item: "pb-3",
  started: "pb-3",
  question: "pb-4",
  event: "pb-3",
  end: "pb-4",
};
/**
 * The virtualizer learns a new scroll position from the scroll event, which arrives after the
 * rows it just mounted measured themselves; until then it corrects their size changes against
 * the old position and drags the view away from where it was sent. Telling it at once (its
 * public `scrollOffset`) keeps a jump where it landed.
 *
 * Only discrete placements use this (a jump landing, a step to a turn): for a moment after,
 * what the virtualizer last rendered lags behind the place code set, so the reader's anchor
 * stays untouched. Keep-place restores across fast pages deliberately skip the freeze, so the
 * anchor keeps tracking the reader instead of going stale and teleporting back to it.
 */
function settle(
  virtualizer: { scrollOffset: number | null },
  el: HTMLElement | null,
  placedUntil: { current: number },
): void {
  if (el) virtualizer.scrollOffset = el.scrollTop;
  placedUntil.current = performance.now() + 250;
}
/**
 * Code that places the view (a jump, a step to a turn) sets the reader's place itself: for a
 * moment after, what the virtualizer last rendered lags behind it.
 */
function placedAt(
  anchor: { current: Anchor | undefined },
  virtualizer: { measurementsCache: readonly { start: number }[] },
  el: HTMLElement | null,
  rows: readonly Row[],
  index: number,
  itemId?: string,
): void {
  const row = rows[index];
  const start = virtualizer.measurementsCache[index]?.start;
  if (!el || !row || start === undefined) return;
  anchor.current = {
    key: row.key,
    index,
    offset: start - el.scrollTop,
    start,
    itemId: itemId ?? blockItems(row.block)[0],
  };
}
/**
 * A progress note followed straight by another sits close to it; a turn's last answer doesn't.
 * An answer under its turn's "Worked for" keeps its time in its hover-actions row, so its
 * changed files sit close.
 */
function rowGap(row: Row, next: Row | undefined): string {
  if (row.block.kind === "message" && next?.block.kind === "message") return "pb-1.5";
  if (row.block.kind === "message" && row.block.headed && next?.block.kind === "files")
    return "pb-1.5";
  return gap[row.block.kind];
}
const rowKey = (row: Row) => row.key;
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
  const reading = useThreadStore(threadId);
  useReadMarker(threadId, nav);
  const window = jump.window;
  const detached = !!window && !jump.joined;
  // The person's messages on their way join the live tail as the bubbles their items become.
  const built = useBlocks(threadId);
  const local = useLocalSendsView(threadId);
  const activity = useTurnActivity(threadId);
  useDropTurnSteps(threadId);
  // The live turn's header sits under its ask; a turn whose ask is not in view (still on its
  // way, older than the window) keeps it at the end instead.
  const working = !detached && !!activity && activity.tone !== "paused";
  const blocks = useMemo(() => {
    const merged = local && !detached ? local.merge(built, blockItems) : built;
    return working && !merged.some((block) => block.kind === "live")
      ? [...merged, tailLive]
      : merged;
  }, [local, built, detached, working]);
  const runOrdinals = useRunOrdinals(threadId);
  const { seqTurns } = props;
  const ordinalOf = useCallback(
    (id: string) => runOrdinals.get(id) ?? seqTurns?.get(id),
    [runOrdinals, seqTurns],
  );
  const handled = useRef(0);
  const focus = jump.focus;
  const rows = useMemo(() => transcriptRows(blocks, ordinalOf), [blocks, ordinalOf]);
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const { rows: motionRows } = useListMotion(blocks, (block: Block) => block.key);
  const entering = useMemo(
    () => new Set(motionRows.flatMap((row) => (row.phase === "enter" ? [row.key] : []))),
    [motionRows],
  );

  const viewport = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(!detached);
  const upwardIntent = useRef(false);
  const glidingUntil = useRef(0);
  // Until this moment the view is where code put it (a restored place, a jump): its scroll
  // events are not the reader's and never page the window.
  const placedUntil = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const [pinned, setPinnedState] = useState(!detached);
  const setPinned = useCallback(
    (value: boolean) => {
      if (!value && pinnedRef.current && reading) nav.jump.retain(reading);
      pinnedRef.current = value;
      setPinnedState(value);
    },
    [nav.jump, reading],
  );
  const [flash, setFlash] = useState<{ key: string; hit: boolean }>();

  // A row filling in (its text, a card's code arriving) moves the rows under it in the same
  // frame, so a thread never paints its rows stacked on each other.
  const placed = usePlaceBeforePaint<HTMLDivElement, Element>();
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
    getItemKey: (index) => rows[index]?.key ?? index,
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
  useForgetGoneRows(virtualizer, rows.length, (index) => rows[index]?.key ?? index);
  const total = virtualizer.getTotalSize();
  const margin = virtualizer.options.scrollMargin;
  const scrollToEnd = () => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const shift = useCallback(
    (delta: number) => {
      // A structural nudge, not a placement: added rows above push the view down, removed
      // ones pull it up, and the reader's own scrolling in between is preserved because the
      // target is relative. Through the virtualizer (not a raw scrollTop set) so its range
      // follows even where no scroll event fires. Sync it at once (see settle) but freeze
      // nothing.
      const el = viewport.current;
      if (!el || delta === 0) return;
      virtualizer.scrollToOffset(el.scrollTop + delta);
      virtualizer.scrollOffset = el.scrollTop;
    },
    [virtualizer],
  );
  const rowOfItem = useCallback((itemId: string) => rowOf(rows, itemId), [rows]);
  const startOf = useCallback(
    (index: number) => virtualizer.measurementsCache[index]?.start,
    [virtualizer],
  );
  useKeepPlace(keys, anchor, pinnedRef, shift, rowOfItem, startOf);
  useStayPinned(viewport, pinnedRef, glidingUntil);
  const dock = useRef<HTMLDivElement>(null);
  useDockShift(dock, viewport, pinnedRef);
  useGutter(viewport);
  // A window that isn't joined to the tail has no live end to follow.
  useEffect(() => {
    if (detached) setPinned(false);
  }, [detached, setPinned]);
  // Leaving a window (back to live, or a link that failed) shows the live tail from its end,
  // never from the top, where it would page older history in.
  const hadWindow = useRef(!!window);
  useLayoutEffect(() => {
    const had = hadWindow.current;
    hadWindow.current = !!window;
    if (!had || window || pinnedRef.current) return;
    setPinned(true);
    scrollToEnd();
  }, [window, setPinned]);
  // Follow streaming output and new rows while the reader is at the live end.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToEnd();
  }, [total, rows]);
  useEffect(() => nav.following.set(pinned && !window), [nav.following, pinned, window]);
  // A joined window the reader follows past is no longer needed: back to the tail alone.
  useEffect(() => {
    if (!window || !jump.joined || !pinned) return;
    const timer = setTimeout(() => nav.jump.live(), 1_500);
    return () => clearTimeout(timer);
  }, [nav.jump, window, jump.joined, pinned]);

  // The live header scrolled out of view above: a copy stays pinned at the top.
  const liveRow = useMemo(() => rows.findIndex((row) => row.block.kind === "live"), [rows]);
  const [livePinned, setLivePinned] = useState(false);
  /** The first row in view, which turn the reader is in, and where its top sits. */
  const readTop = () => {
    const el = viewport.current;
    if (!el) return;
    const top = el.scrollTop + topRoom;
    const items = virtualizer.getVirtualItems();
    const first = items.find((item) => item.end > top);
    if (!first) return;
    const liveItem = items.find((item) => item.index === liveRow);
    const pinLive =
      liveRow >= 0 && (liveItem ? liveItem.end <= el.scrollTop : first.index > liveRow);
    if (pinLive !== livePinned) setLivePinned(pinLive);
    const row = rows[first.index];
    // While code is placing the view (a jump landing, a restored place), the place it set is
    // the reader's; what the virtualizer last rendered may not have caught up yet.
    if (performance.now() >= placedUntil.current)
      anchor.current = {
        key: row?.key ?? String(first.key),
        index: first.index,
        offset: first.start - el.scrollTop,
        start: first.start,
        itemId: row ? blockItems(row.block)[0] : undefined,
      };
    const turnFrom = (index: number) => {
      for (let at = index; at < Math.min(rows.length, index + 8); at++) {
        const ordinal = rows[at]?.ordinal;
        if (ordinal !== undefined) return ordinal;
      }
      return undefined;
    };
    const topTurn = turnFrom(first.index);
    if (topTurn !== undefined) nav.currentTurn.set(topTurn);
  };
  useEffect(readTop);

  const [olderIntent, setOlderIntent] = useState(false);
  const [newerIntent, setNewerIntent] = useState(false);
  const landing = useRef(0);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const stop = () => {
      landing.current++;
    };
    return listenScrollIntent(
      el,
      (upward) => {
        upwardIntent.current = upward;
        setOlderIntent(upward);
        setNewerIntent(!upward);
        if (upward) {
          glidingUntil.current = 0;
          setPinned(false);
        } else if (!detached && el.scrollHeight - el.scrollTop - el.clientHeight < nearEdge)
          setPinned(true);
      },
      stop,
    );
  }, [setPinned, detached]);

  // A jump (or a search hit) brings its item into view once its row exists.
  // One placement only: re-aiming over many frames fights the reader's own
  // scrolling and reads as jumpiness once neighbours finish measuring.
  useLayoutEffect(() => {
    if (!focus || handled.current === focus.nonce) return;
    const index = rowOf(rows, focus.itemId);
    if (index < 0) return;
    handled.current = focus.nonce;
    landing.current++;
    setPinned(false);
    virtualizer.scrollToIndex(index, { align: focus.query ? "center" : "start" });
    settle(virtualizer, viewport.current, placedUntil);
    const key = rows[index]?.key;
    if (key) setFlash({ key, hit: focus.query !== undefined });
    // The jump's row is the reader's place from now on, so rows sliding around it
    // (the window's turns arriving, say) keep it where it landed.
    placedAt(anchor, virtualizer, viewport.current, rows, index, focus.itemId);
  }, [focus, rows, virtualizer, setPinned]);
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
  // Only scrolls backed by reader intent may page.
  // Older history loads one request per upward gesture, well before the edge, so
  // paging in never surfaces as a visible jump. A reply, a jump settling, or a
  // keep-place restore fires scroll events with no gesture behind them, and those
  // must never walk the history by themselves.
  const maybeLoadOlder = useCallback(
    (scrollTop: number) => {
      if (
        olderIntent &&
        scrollTop < 900 &&
        hasOlder &&
        !loading &&
        !pager.error &&
        !jump.failed &&
        !jump.loading
      ) {
        setOlderIntent(false);
        void loadOlder();
      }
    },
    [olderIntent, hasOlder, loading, pager.error, jump.failed, jump.loading, loadOlder],
  );
  const prefetchFocus = useRef(focus?.nonce);
  useEffect(() => {
    if (prefetchFocus.current !== focus?.nonce) {
      prefetchFocus.current = focus?.nonce;
      setOlderIntent(false);
      setNewerIntent(false);
      return;
    }
    if (olderIntent && !pinned) {
      const top = viewport.current?.scrollTop ?? 0;
      if (top < 1200 && hasOlder && !loading && !pager.error && !jump.failed) {
        setOlderIntent(false);
        void loadOlder();
      }
    }
  }, [focus?.nonce, olderIntent, pinned, hasOlder, loading, pager.error, jump.failed, loadOlder]);
  // Newer history loads the same way, mirrored: one request per downward
  // gesture while near the live end, so scrolling back toward live is one
  // continuous list. A wheel or key at the very bottom moves no scroll offset,
  // so the intent effect below must page on its own; scroll events with no
  // gesture behind them (a jump landing, a keep-place restore) never do, so a
  // page settling can't chain into the next one and stick the view flickering.
  const distanceToLive = () => {
    const el = viewport.current;
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : Number.POSITIVE_INFINITY;
  };
  const maybeLoadNewer = useCallback(
    (distance: number) => {
      if (
        newerIntent &&
        distance < 900 &&
        detached &&
        window &&
        !jump.loading &&
        !loading &&
        !pager.error &&
        !jump.failed
      ) {
        setNewerIntent(false);
        void nav.jump.newer();
      }
    },
    [newerIntent, detached, window, jump.loading, jump.failed, loading, pager.error, nav.jump],
  );
  useEffect(() => {
    if (prefetchFocus.current !== focus?.nonce) return;
    if (newerIntent && !pinned && detached && window) {
      if (distanceToLive() < 1200 && !jump.loading && !loading && !pager.error && !jump.failed) {
        setNewerIntent(false);
        void nav.jump.newer();
      }
    }
  }, [
    focus?.nonce,
    newerIntent,
    pinned,
    detached,
    window,
    jump.loading,
    jump.failed,
    loading,
    pager.error,
    nav.jump,
  ]);
  const toLive = () => {
    upwardIntent.current = false;
    setOlderIntent(false);
    setNewerIntent(false);
    glidingUntil.current = performance.now() + 800;
    setPinned(true);
    if (window) nav.jump.live();
    else if (viewport.current) glideToEnd(viewport.current, true);
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
              readTop();
              maybeLoadNewer(el.scrollHeight - el.scrollTop - el.clientHeight);
              maybeLoadOlder(el.scrollTop);
              const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < nearEdge;
              if (!atEnd && performance.now() < glidingUntil.current) return;
              // A detached window's end is not the live end.
              const following = atEnd && !detached && !upwardIntent.current;
              // Measurements can move the scroll offset before the next pin-to-end pass.
              // Only reader intent (or a detached window) releases that live pin.
              if (
                (following || detached || upwardIntent.current) &&
                following !== pinnedRef.current
              )
                setPinned(following);
            }}
          >
            <div className={`${readingColumn} pt-6 pb-[calc(var(--composer-clearance,0px)+4rem)]`}>
              {hasOlder && (
                <div className="flex min-h-8 justify-center pb-4">
                  {loading && (
                    <span role="status" aria-label="Loading earlier messages">
                      <Spinner />
                    </span>
                  )}
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
                  <DeferredLocalSends.Component threadId={threadId} />
                  <DeferredHeldSend.Component threadId={threadId} />
                  <AgentPageReveal threadId={threadId} />
                </Suspense>
              )}
            </div>
          </div>
          {livePinned && working && (
            <div className="absolute inset-x-0 top-0 z-[5] bg-reading pb-1">
              <div className={readingColumn}>
                <LiveHead threadId={threadId} />
              </div>
            </div>
          )}
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
            anchor={anchor}
            nav={nav}
            scrollTo={(index) => {
              setPinned(false);
              virtualizer.scrollToIndex(index, { align: "start" });
              settle(virtualizer, viewport.current, placedUntil);
              placedAt(anchor, virtualizer, viewport.current, rows, index);
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
