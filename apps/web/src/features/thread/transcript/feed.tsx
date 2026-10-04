import { useItemOrder, type HistoryPager } from "@ace/client-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { scrollToEnd as glideToEnd, useListMotion } from "@/lib/motion.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";
import { DeferredSearchBar } from "../deferred.ts";
import { BlockView } from "../items/block-view.tsx";
import { readingColumn } from "../lib/column.ts";
import { GapRow, JumpBar, LivePill } from "../long/jump-chrome.tsx";
import type { JumpSnapshot } from "../long/jump-controller.ts";
import type { ThreadNav } from "../long/nav.tsx";
import { FoldedTurn, OpenTurnHead } from "../long/turn-row.tsx";
import { openWorkIndex, type Block } from "./blocks.ts";
import { LiveFooter, useRootWorking } from "./live-footer.tsx";
import { newestOrdinal, recentTurns, rowOf, transcriptRows, type Row } from "./rows.ts";
import { useGutter, useKeepPlace, useStayPinned, type Anchor } from "./scroll.ts";
import { useRunOrdinals } from "./run-ordinals.ts";
import { useBlocks } from "./use-blocks.ts";
import { useNewActivity } from "./use-new-activity.ts";

const none: readonly string[] = [];
const nearEdge = 64;
/** Room above a row brought into view, for the bars that float over the transcript's top. */
const topRoom = 56;
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
 * The virtualizer learns a new scroll position from the scroll event, which arrives after the
 * rows it just mounted measured themselves; until then it corrects their size changes against
 * the old position and drags the view away from where it was sent. Telling it at once (its
 * public `scrollOffset`) keeps a jump where it landed.
 */
function settle(virtualizer: { scrollOffset: number | null }, el: HTMLElement | null): void {
  if (el) virtualizer.scrollOffset = el.scrollTop;
}
const rowGap = (row: Row) => (row.kind === "block" ? gap[row.block.kind] : "pb-1");
const rowKey = (row: Row) => row.key;
const highlight = {
  boxShadow: "0 0 0 2px color-mix(in oklab, var(--ring) 45%, transparent)",
  borderRadius: 12,
  transition: "box-shadow var(--dur-3) var(--ease)",
};

export interface FeedProps {
  threadId: string;
  nav: ThreadNav;
  jump: JumpSnapshot;
  pager: HistoryPager;
  /** Jumped windows' items' turns, from the turn index. */
  seqTurns: ReadonlyMap<string, number> | undefined;
  /** How many turns the thread has, when the index has been read. */
  turnCount: number | undefined;
  /** Items that reached the live end since the reader left it. */
  fresh: { count: number; more: boolean };
  liveNewest: string | undefined;
  /** Cards that float over the transcript's top, under search and the jump bar. */
  overlay?: ReactNode;
}

/**
 * The virtualized rows of the transcript (live tail or a jumped window, through the window
 * provider), with the bars that float over it. The compiler skips this component (the
 * virtualizer's callbacks are unstable by design); the rows it renders are compiled.
 */
export function Feed(props: FeedProps) {
  const { threadId, nav, jump, pager } = props;
  const window = jump.window;
  const detached = !!window && !jump.joined;
  const blocks = useBlocks(threadId);
  const order = useItemOrder(threadId) ?? none;
  const runOrdinals = useRunOrdinals(threadId);
  const { seqTurns } = props;
  const ordinalOf = useCallback(
    (id: string) => runOrdinals.get(id) ?? seqTurns?.get(id),
    [runOrdinals, seqTurns],
  );
  // Older turns the reader opened, and the turn a jump is still bringing into view.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const handled = useRef(0);
  const focus = jump.focus;
  const focusOrdinal = focus ? ordinalOf(focus.itemId) : undefined;
  const open = useMemo(() => {
    const set = new Set(opened);
    if (focus && handled.current !== focus.nonce && focusOrdinal !== undefined)
      set.add(focusOrdinal);
    return set;
  }, [opened, focus, focusOrdinal]);
  const latest = newestOrdinal(blocks, ordinalOf);
  const openFrom = detached || latest === undefined ? Infinity : latest - recentTurns + 1;
  const rows = useMemo(
    () => transcriptRows(blocks, { ordinalOf, open, openFrom }),
    [blocks, ordinalOf, open, openFrom],
  );
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const divider = useNewActivity(threadId, blocks, order, props.liveNewest);
  const { rows: motionRows } = useListMotion(blocks, (block: Block) => block.key);
  const entering = useMemo(
    () => new Set(motionRows.flatMap((row) => (row.phase === "enter" ? [row.key] : []))),
    [motionRows],
  );
  const openWork = openWorkIndex(blocks);
  const rootWorking = useRootWorking(threadId);
  const liveWork = !detached && rootWorking && openWork >= 0;
  const liveBlock = liveWork ? blocks[openWork]?.key : undefined;

  const viewport = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(!detached);
  const glidingUntil = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const [pinned, setPinnedState] = useState(!detached);
  const setPinned = useCallback((value: boolean) => {
    pinnedRef.current = value;
    setPinnedState(value);
  }, []);
  const [flash, setFlash] = useState<{ key: string; hit: boolean }>();

  // oxlint-disable-next-line react-compiler/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => (rows[index]?.kind === "block" ? 96 : 36),
    overscan: 8,
    scrollMargin: feed.current?.offsetTop ?? 0,
    scrollPaddingStart: topRoom,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  useForgetGoneRows(virtualizer, rows.length, (index) => rows[index]?.key ?? index);
  const total = virtualizer.getTotalSize();
  const margin = virtualizer.options.scrollMargin;
  const scrollToEnd = () => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const restore = useCallback(
    (index: number, offset: number) => {
      const start = virtualizer.measurementsCache[index]?.start;
      if (start === undefined) virtualizer.scrollToIndex(index, { align: "start" });
      else virtualizer.scrollToOffset(start - offset);
      settle(virtualizer, viewport.current);
    },
    [virtualizer],
  );
  useKeepPlace(keys, anchor, pinnedRef, restore);
  useStayPinned(viewport, pinnedRef, glidingUntil);
  useGutter(viewport);
  // A window that isn't joined to the tail has no live end to follow.
  useEffect(() => {
    if (detached) setPinned(false);
  }, [detached, setPinned]);
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

  /** The first row in view, which turn the reader is in, and where its top sits. */
  const readTop = () => {
    const el = viewport.current;
    if (!el) return;
    const top = el.scrollTop + topRoom;
    const first = virtualizer.getVirtualItems().find((item) => item.end > top);
    if (!first) return;
    anchor.current = {
      key: rows[first.index]?.key ?? String(first.key),
      index: first.index,
      offset: first.start - el.scrollTop,
    };
    for (let index = first.index; index < Math.min(rows.length, first.index + 8); index++) {
      const ordinal = rows[index]?.ordinal;
      if (ordinal !== undefined) {
        nav.currentTurn.set(ordinal);
        return;
      }
    }
  };
  useEffect(readTop);

  // A jump (or a search hit) brings its item into view once its row exists.
  useLayoutEffect(() => {
    if (!focus || handled.current === focus.nonce) return;
    const index = rowOf(rows, focus.itemId);
    if (index < 0) return;
    handled.current = focus.nonce;
    setPinned(false);
    if (focusOrdinal !== undefined && rows[index]?.kind !== "turn")
      setOpened((previous) =>
        previous.has(focusOrdinal) ? previous : new Set(previous).add(focusOrdinal),
      );
    virtualizer.scrollToIndex(index, { align: focus.query ? "center" : "start" });
    settle(virtualizer, viewport.current);
    const key = rows[index]?.key;
    if (key) setFlash({ key, hit: focus.query !== undefined });
  }, [focus, rows, focusOrdinal, virtualizer, setPinned]);
  useEffect(() => {
    if (!flash || flash.hit) return;
    const timer = setTimeout(() => setFlash(undefined), 1_600);
    return () => clearTimeout(timer);
  }, [flash]);

  const items = virtualizer.getVirtualItems();
  const firstVisible = items[0]?.index;
  const { hasOlder, loading, loadOlder } = pager;
  // The live tail pages older history in when its first row shows.
  useEffect(() => {
    if (!window && firstVisible === 0 && hasOlder && !loading && !pinnedRef.current)
      void loadOlder();
  }, [window, firstVisible, hasOlder, loading, loadOlder]);
  // A jumped window slides only as the reader scrolls toward one of its edges, so a window
  // that fits on screen never pages itself in both directions.
  const lastTop = useRef(0);
  const slideOnScroll = (el: HTMLElement) => {
    const moved = el.scrollTop - lastTop.current;
    lastTop.current = el.scrollTop;
    if (!window || jump.loading || moved === 0) return;
    const room = el.clientHeight;
    if (moved < 0 && el.scrollTop < room && hasOlder) void loadOlder();
    else if (moved > 0 && detached && el.scrollHeight - el.scrollTop - el.clientHeight < room)
      void nav.jump.newer();
  };

  const toLive = () => {
    glidingUntil.current = performance.now() + 800;
    setPinned(true);
    if (window) nav.jump.live();
    else if (viewport.current) glideToEnd(viewport.current, true);
  };
  useTurnKeys(rows, anchor, nav, props.turnCount, {
    scrollTo: (index) => {
      setPinned(false);
      virtualizer.scrollToIndex(index, { align: "start" });
      settle(virtualizer, viewport.current);
    },
    toLive,
  });

  const lastWindowOrdinal = window ? ordinalOf(window.items.at(-1)?.id ?? "") : undefined;
  const dividerRow = divider && rows.find((row) => row.key === divider)?.key;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={viewport}
        data-virtual-viewport=""
        // A classic scrollbar reserves the same room on both edges, so the column stays centred
        // on the composer's axis; `useGutter` gives the composer the same inset.
        className="scroll-fade-t min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-fade-t-6 [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
        onScroll={(event) => {
          const el = event.currentTarget;
          readTop();
          slideOnScroll(el);
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < nearEdge;
          if (!atEnd && performance.now() < glidingUntil.current) return;
          // A detached window's end is not the live end.
          const following = atEnd && !detached;
          if (following !== pinnedRef.current) setPinned(following);
        }}
      >
        <div className={`${readingColumn} pt-6 pb-16`}>
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
            aria-busy={loading || jump.loading !== undefined}
            className="relative w-full"
            style={{ height: total }}
          >
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
                  className={cn("absolute inset-x-0 top-0", rowGap(row))}
                  style={{ transform: `translateY(${item.start - margin}px)` }}
                >
                  <div
                    className={entering.has(row.key) ? "fx-rise-in" : undefined}
                    style={lit ? highlight : undefined}
                  >
                    {dividerRow === row.key && <NewActivity />}
                    <RowView
                      threadId={threadId}
                      row={row}
                      live={row.key === liveBlock}
                      onOpen={(ordinal) => setOpened((previous) => new Set(previous).add(ordinal))}
                      onFold={(ordinal) =>
                        setOpened((previous) => {
                          const next = new Set(previous);
                          next.delete(ordinal);
                          return next;
                        })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {detached ? (
            <GapRow
              newerTurns={
                props.turnCount !== undefined && lastWindowOrdinal !== undefined
                  ? props.turnCount - lastWindowOrdinal
                  : undefined
              }
              loading={jump.loading === "newer"}
              onNewer={() => void nav.jump.newer()}
              onLive={toLive}
            />
          ) : (
            <LiveFooter threadId={threadId} quiet={liveWork} />
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-3 z-[6] flex flex-col items-center gap-2 px-4">
        {nav.searchOpen && (
          <Suspense fallback={null}>
            <DeferredSearchBar.Component nav={nav} />
          </Suspense>
        )}
        {detached && (
          <JumpBar turn={jump.turn} count={props.turnCount} failed={jump.failed} onLive={toLive} />
        )}
        {!window && jump.failed && (
          <p
            role="alert"
            style={{ pointerEvents: "auto" }}
            className="glass flex h-8 items-center gap-2 rounded-full pr-1 pl-3 text-sm text-status-failed"
          >
            {jump.failed}
            <Button variant="ghost" size="sm" onClick={() => nav.jump.dismissError()}>
              Dismiss
            </Button>
          </p>
        )}
        {!detached && props.overlay}
      </div>
      {(!pinned || detached) && (
        <LivePill
          newItems={props.fresh.count}
          more={props.fresh.more}
          paused={rootWorking}
          onClick={toLive}
        />
      )}
    </div>
  );
}

function RowView(props: {
  threadId: string;
  row: Row;
  live: boolean;
  onOpen(ordinal: number): void;
  onFold(ordinal: number): void;
}) {
  const { row } = props;
  switch (row.kind) {
    case "block":
      return <BlockView threadId={props.threadId} block={row.block} live={props.live} />;
    case "turn":
      return (
        <FoldedTurn
          threadId={props.threadId}
          ordinal={row.ordinal}
          askId={row.askId}
          onOpen={() => props.onOpen(row.ordinal)}
        />
      );
    case "head":
      return <OpenTurnHead ordinal={row.ordinal} onFold={() => props.onFold(row.ordinal)} />;
  }
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

/** Where each turn starts among the rows. */
function turnStarts(rows: readonly Row[]): { index: number; ordinal: number }[] {
  const starts: { index: number; ordinal: number }[] = [];
  let previous: number | undefined;
  rows.forEach((row, index) => {
    const ordinal = row.ordinal;
    if (ordinal === undefined || ordinal === previous) return;
    starts.push({ index, ordinal });
    previous = ordinal;
  });
  return starts;
}

/**
 * ⌥⌘↑ and ⌥⌘↓: the previous and next turn. Within the rows it scrolls; past them it jumps
 * (a window of older history, or the live end after the last turn).
 */
function useTurnKeys(
  rows: readonly Row[],
  anchor: { current: Anchor | undefined },
  nav: ThreadNav,
  turnCount: number | undefined,
  actions: { scrollTo(index: number): void; toLive(): void },
) {
  const step = (direction: 1 | -1) => {
    const starts = turnStarts(rows);
    const top = anchor.current?.index ?? 0;
    const current = nav.currentTurn.get();
    if (direction === 1) {
      const next = starts.find((start) => start.index > top);
      if (next) return actions.scrollTo(next.index);
      const last = current ?? starts.at(-1)?.ordinal;
      if (last !== undefined && turnCount !== undefined && last < turnCount)
        return void nav.jump.toTurn(last + 1);
      return actions.toLive();
    }
    const here = starts.findLast((start) => start.index <= top);
    const offset = anchor.current?.offset ?? 0;
    if (here && (here.index < top || offset < -8)) return actions.scrollTo(here.index);
    const previous = starts.findLast((start) => start.index < (here?.index ?? top));
    if (previous) return actions.scrollTo(previous.index);
    const first = here?.ordinal ?? current;
    if (first !== undefined && first > 1) void nav.jump.toTurn(first - 1);
  };
  useHotkey(keymap.nextTurn.keys, () => step(1));
  useHotkey(keymap.previousTurn.keys, () => step(-1));
}
