import type { ThreadReader } from "@ace/client";
import { useItemOrder, type HistoryPager } from "@ace/client-react";
import { ledgerOf } from "@ace/ui-core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useTopFade } from "@/lib/edge-fade.ts";
import { scrollToEnd as glideToEnd, useListMotion } from "@/lib/motion.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";
import {
  DeferredFoldedTurn,
  DeferredGapRow,
  DeferredJumpBar,
  DeferredJumpFailed,
  DeferredLivePill,
  DeferredOpenTurnHead,
  DeferredSearchBar,
  DeferredTurnKeys,
} from "../deferred.ts";
import { BlockView } from "../items/block-view.tsx";
import { readingColumn } from "../lib/column.ts";
import type { JumpSnapshot } from "../long/jump-controller.ts";
import type { ThreadNav } from "../long/nav.tsx";
import { blockItems, type Block } from "./blocks.ts";
import { LiveFooter } from "./live-footer.tsx";
import { newestOrdinal, recentFrom, rowOf, transcriptRows, turnCount, type Row } from "./rows.ts";
import { useDockShift, useGutter, useKeepPlace, useStayPinned, type Anchor } from "./scroll.ts";
import { useRunOrdinals } from "./run-ordinals.ts";
import { useBlocks } from "./use-blocks.ts";
import { useTurnActivity } from "./use-turn-activity.ts";
import { useWatched, type Watched } from "./use-watched.ts";
import { useNewActivity } from "./use-new-activity.ts";

const none: readonly string[] = [];
const unsettledKeys = ["order", "interactions"] as const;
interface Unsettled {
  /** Steps still in flight (or awaiting approval) and the steps open requests came from. */
  items: ReadonlySet<string>;
  /** Requests still waiting on the person. */
  requests: ReadonlySet<string>;
}
const settledNothing: Unsettled = { items: new Set(), requests: new Set() };
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));
const sameUnsettled = (a: Unsettled, b: Unsettled) =>
  sameSet(a.items, b.items) && sameSet(a.requests, b.requests);
/**
 * What must never fold away, from the thread's shared ledger (costs what changed): the steps in
 * flight, each watched so its settling lets its turn fold, and the open requests.
 */
function readUnsettled(reader: ThreadReader): Watched<Unsettled> {
  const ledger = ledgerOf(reader);
  const flying = [...ledger.inFlight()];
  const items = new Set(flying);
  const requests = new Set<string>();
  for (const interaction of ledger.pending()) {
    requests.add(interaction.id);
    if (interaction.toolCallId) items.add(interaction.toolCallId);
  }
  return {
    value: items.size || requests.size ? { items, requests } : settledNothing,
    watch: flying.map((id) => `item:${id}`),
  };
}
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
  question: "pb-4",
  event: "pb-3",
  end: "pb-4",
};
/**
 * The virtualizer learns a new scroll position from the scroll event, which arrives after the
 * rows it just mounted measured themselves; until then it corrects their size changes against
 * the old position and drags the view away from where it was sent. Telling it at once (its
 * public `scrollOffset`) keeps a jump where it landed.
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
    itemId: itemId ?? rowItem(row),
  };
}
const viewportStyle = { paddingRight: "var(--summary-inset, 0px)" } as CSSProperties;
/** A progress note followed straight by another sits close to it; a turn's last answer doesn't. */
function rowGap(row: Row, next: Row | undefined): string {
  if (row.kind !== "block") return "pb-1";
  if (row.block.kind === "message" && next?.kind === "block" && next.block.kind === "message")
    return "pb-1.5";
  return gap[row.block.kind];
}
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
  /** Items that reached the live end since the reader left it. */
  fresh: { count: number; more: boolean };
  liveNewest: string | undefined;
  /** A card docked above the transcript (the catch-up card): it pushes the rows down. */
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
  // Turns with a step still running or a request still open never fold.
  const unsettled =
    useWatched(threadId, unsettledKeys, readUnsettled, sameUnsettled) ?? settledNothing;
  const keep = useCallback(
    (block: Block) =>
      (block.kind === "question" && unsettled.requests.has(block.interactionId)) ||
      blockItems(block).some((id) => unsettled.items.has(id)),
    [unsettled],
  );
  const open = useMemo(() => {
    const set = new Set(opened);
    if (focus && handled.current !== focus.nonce && focusOrdinal !== undefined)
      set.add(focusOrdinal);
    return set;
  }, [opened, focus, focusOrdinal]);
  // Live, every turn shows whole until the window is long; then the newest ones do. In a jumped
  // window the reader reads on from the turn they jumped to: it and every later turn show
  // whole, the turns before it fold.
  const latest = newestOrdinal(blocks, ordinalOf);
  const recent = recentFrom(latest, turnCount(blocks, ordinalOf), order.length);
  // A window not joined to the tail holds no recent turns: only its own from the jump on.
  const openFrom = detached
    ? (jump.turn ?? Infinity)
    : window
      ? Math.min(jump.turn ?? Infinity, recent)
      : recent;
  const rows = useMemo(
    () => transcriptRows(blocks, { ordinalOf, open, openFrom, keep }),
    [blocks, ordinalOf, open, openFrom, keep],
  );
  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const divider = useNewActivity(threadId, blocks, order, props.liveNewest);
  const { rows: motionRows } = useListMotion(blocks, (block: Block) => block.key);
  const entering = useMemo(
    () => new Set(motionRows.flatMap((row) => (row.phase === "enter" ? [row.key] : []))),
    [motionRows],
  );
  // The turn's one live line: the bottom work log's header while the agent works on it, else
  // the footer under the last block. Never both.
  const activity = useTurnActivity(threadId);
  const rootWorking = activity?.tone === "working";
  const bottom = blocks.at(-1);
  const liveBlock =
    !detached && rootWorking && activity?.elapsedFrom !== undefined && bottom?.kind === "work"
      ? bottom.key
      : undefined;
  const inline = useMemo(
    () =>
      new Set(blocks.flatMap((block) => (block.kind === "question" ? [block.interactionId] : []))),
    [blocks],
  );

  const viewport = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(!detached);
  const glidingUntil = useRef(0);
  // Until this moment the view is where code put it (a restored place, a jump): its scroll
  // events are not the reader's and never page the window.
  const placedUntil = useRef(0);
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
      settle(virtualizer, viewport.current, placedUntil);
    },
    [virtualizer],
  );
  const rowOfItem = useCallback((itemId: string) => rowOf(rows, itemId), [rows]);
  useKeepPlace(keys, anchor, pinnedRef, restore, rowOfItem);
  // Rows changing (a slide, a fold, history paging in) move the view by themselves; those
  // scroll events are not the reader's.
  useLayoutEffect(() => {
    placedUntil.current = performance.now() + 250;
  }, [keys]);
  useStayPinned(viewport, pinnedRef, glidingUntil);
  const dock = useRef<HTMLDivElement>(null);
  useDockShift(dock, viewport, pinnedRef);
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

  // The turn in the middle of the view: what the jump bar says the reader is looking at.
  const [reading, setReading] = useState<number>();
  /** The first row in view, which turn the reader is in, and where its top sits. */
  const readTop = () => {
    const el = viewport.current;
    if (!el) return;
    const top = el.scrollTop + topRoom;
    const items = virtualizer.getVirtualItems();
    const first = items.find((item) => item.end > top);
    if (!first) return;
    const row = rows[first.index];
    // While code is placing the view (a jump landing, a restored place), the place it set is
    // the reader's; what the virtualizer last rendered may not have caught up yet.
    if (performance.now() >= placedUntil.current)
      anchor.current = {
        key: row?.key ?? String(first.key),
        index: first.index,
        offset: first.start - el.scrollTop,
        itemId: row ? rowItem(row) : undefined,
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
    const middle = el.scrollTop + el.clientHeight / 2;
    const centre = items.find((item) => item.end > middle) ?? first;
    const centreTurn = turnFrom(centre.index);
    if (centreTurn !== reading) setReading(centreTurn);
  };
  useEffect(readTop);

  // Rows above a jump's target measure only once they render, and the virtualizer aimed with
  // estimates: keep re-aiming at the target for a few frames until the view holds still, so a
  // jump lands on its row however its neighbours measure. The reader's own scrolling stops it.
  const rowsNow = useRef(rows);
  useLayoutEffect(() => {
    rowsNow.current = rows;
  }, [rows]);
  const landing = useRef(0);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const stop = () => {
      landing.current++;
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("keydown", stop);
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("keydown", stop);
    };
  }, []);
  const keepLanding = useCallback(
    (key: string, itemId: string, align: "start" | "center") => {
      const nonce = ++landing.current;
      let frames = 0;
      let still = 0;
      let last = -1;
      const step = () => {
        const el = viewport.current;
        if (landing.current !== nonce || !el || frames++ > 60 || still >= 3) return;
        const index = rowsNow.current.findIndex((row) => row.key === key);
        if (index < 0) return;
        virtualizer.scrollToIndex(index, { align });
        settle(virtualizer, el, placedUntil);
        placedAt(anchor, virtualizer, el, rowsNow.current, index, itemId);
        const at = el.scrollTop + virtualizer.getTotalSize();
        still = at === last ? still + 1 : 0;
        last = at;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [virtualizer],
  );

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
    settle(virtualizer, viewport.current, placedUntil);
    const key = rows[index]?.key;
    if (key) setFlash({ key, hit: focus.query !== undefined });
    // The jump's row is the reader's place from now on, so rows folding or sliding around it
    // (the window's turns arriving, say) keep it where it landed.
    placedAt(anchor, virtualizer, viewport.current, rows, index, focus.itemId);
    if (key) keepLanding(key, focus.itemId, focus.query ? "center" : "start");
  }, [focus, rows, focusOrdinal, virtualizer, setPinned, keepLanding]);
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
  // that fits on screen never pages itself in both directions. Travel counts the reader's own
  // scrolling one way; code moving the view (a restored place, a jump) never adds to it.
  const lastTop = useRef(0);
  const travel = useRef(0);
  const slideOnScroll = (el: HTMLElement) => {
    const moved = el.scrollTop - lastTop.current;
    lastTop.current = el.scrollTop;
    if (performance.now() < placedUntil.current) {
      travel.current = 0;
      return;
    }
    travel.current =
      Math.sign(moved) === Math.sign(travel.current) ? travel.current + moved : moved;
    if (!window || jump.loading || Math.abs(travel.current) < 120) return;
    const room = el.clientHeight;
    if (travel.current < 0 && el.scrollTop < room && hasOlder) void loadOlder();
    else if (
      travel.current > 0 &&
      detached &&
      el.scrollHeight - el.scrollTop - el.clientHeight < room
    )
      void nav.jump.newer();
  };
  const toLive = () => {
    glidingUntil.current = performance.now() + 800;
    setPinned(true);
    if (window) nav.jump.live();
    else if (viewport.current) glideToEnd(viewport.current, true);
  };

  const lastWindowOrdinal = window ? ordinalOf(window.items.at(-1)?.id ?? "") : undefined;
  const fadeTop = useTopFade(viewport);
  const dividerRow = divider && rows.find((row) => row.key === divider)?.key;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={dock} className="flex flex-none justify-center px-4 pt-3 empty:hidden">
        {!window && props.overlay}
      </div>
      {/* The rows and the bars that float over their top (search, the jump bar). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewport}
          data-virtual-viewport=""
          // A classic scrollbar reserves the same room on both edges, so the column stays centred
          // on the composer's axis; `useGutter` gives the composer the same inset.
          // Once scrolled, the top 16px fade, so nothing reads as cut under the header; a pinned
          // summary beside the text keeps it clear (`--summary-inset`).
          style={
            fadeTop
              ? { ...viewportStyle, maskImage: fadeTop, WebkitMaskImage: fadeTop }
              : viewportStyle
          }
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
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
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loading}
                  onClick={() => void loadOlder()}
                >
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
                    className={cn("absolute inset-x-0 top-0", rowGap(row, rows[item.index + 1]))}
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
                        onOpen={(ordinal) =>
                          setOpened((previous) => new Set(previous).add(ordinal))
                        }
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
              <Suspense fallback={null}>
                <DeferredGapRow.Component
                  threadId={threadId}
                  lastTurn={lastWindowOrdinal}
                  loading={jump.loading === "newer"}
                  onNewer={() => void nav.jump.newer()}
                  onLive={toLive}
                />
              </Suspense>
            ) : (
              <LiveFooter
                threadId={threadId}
                // A usage-limit pause is a transcript block, not a live line.
                activity={liveBlock || activity?.tone === "paused" ? undefined : activity}
                inline={inline}
              />
            )}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[6] flex flex-col items-center gap-2 px-4">
          {nav.searchOpen && (
            <Suspense fallback={null}>
              <DeferredSearchBar.Component nav={nav} />
            </Suspense>
          )}
          {window && (
            <Suspense fallback={null}>
              <DeferredJumpBar.Component
                turn={jump.turn}
                reading={reading}
                threadId={threadId}
                failed={jump.failed}
                onLive={toLive}
              />
            </Suspense>
          )}
          {!window && jump.failed && (
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
      {(!pinned || detached) && (
        <Suspense fallback={null}>
          <DeferredLivePill.Component
            newItems={props.fresh.count}
            more={props.fresh.more}
            paused={rootWorking}
            onClick={toLive}
          />
        </Suspense>
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
        <Suspense fallback={<TurnLine ordinal={row.ordinal} />}>
          <DeferredFoldedTurn.Component
            threadId={props.threadId}
            ordinal={row.ordinal}
            askId={row.askId}
            onOpen={() => props.onOpen(row.ordinal)}
          />
        </Suspense>
      );
    case "head":
      return (
        <Suspense fallback={<TurnLine ordinal={row.ordinal} />}>
          <DeferredOpenTurnHead.Component
            ordinal={row.ordinal}
            onFold={() => props.onFold(row.ordinal)}
          />
        </Suspense>
      );
  }
}

/** An item a row shows, for finding it again once it folds or opens. */
function rowItem(row: Row): string | undefined {
  if (row.kind === "turn") return row.itemIds[0];
  if (row.kind === "block") return blockItems(row.block)[0];
  return undefined;
}

/** A turn's line while its row's code loads (it loads while idle, so rarely seen). */
function TurnLine(props: { ordinal: number }) {
  return (
    <p className="flex h-8 items-center font-mono text-xs tabular-nums text-subtle-foreground">
      Turn {props.ordinal}
    </p>
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
