import { ArrowClockwiseIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn.ts";
import { useParams } from "@tanstack/react-router";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { rowMotion, useListMotion } from "@/lib/motion.ts";
import {
  activeGroupLabels,
  activeRows,
  homeFootStart,
  homeRowKey,
  homeRowThread,
  listOrderOf,
  settledRows,
  type HomeRow,
  type RowBox,
  type SettledItem,
} from "@ace/ui-core";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useElementSize } from "@/lib/element-size.ts";
import { matchesChord } from "@/lib/hotkeys.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { parseChord } from "@/lib/keymap.ts";
import {
  focusListRow,
  focusRowFrom,
  roveListFocus,
  rowFocusSelector,
  stepIntoActions,
  typeAheadIndex,
} from "./list-focus.ts";
import { jumpTargets } from "./list-jump.ts";
import { JumpKeys, useJumpHints } from "./list-jump-keys.tsx";
import { useFocusAfterExit } from "./use-exit-focus.ts";
import { ManyDevices, useManyDevices } from "./row-parts.tsx";
import { ThreadRow } from "./thread-row.tsx";
import { MachineRow } from "./machine-row.tsx";
import { machineRow } from "@/lib/machine-threads.ts";
import { SettledMatch } from "./settled-match.tsx";
import { UnsentRows } from "./unsent-rows.tsx";
import { useHomeSort, type HomeList } from "./use-home-threads.ts";
import { useHeldRows, useListHold } from "./use-held-rows.ts";
import { useNow } from "@/lib/time.ts";
import type { SearchHit } from "./use-panel-search.ts";
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizer,
  useOrganizerState,
  useWindowThreads,
} from "@/features/organize/index.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";
import type { DragHost, KeyboardMove } from "./list-drag.ts";

/**
 * A thread row is 52px tall and keeps 2px below it: rows are apart by spacing, not rules. A
 * settled row is one 30px line.
 */
const estimates: Record<HomeRow["kind"], number> = {
  "pinned-header": 29,
  pinned: 54,
  "pinned-end": 9,
  "group-header": 39,
  thread: 54,
  unsent: 0,
  "snoozed-header": 39,
  snoozed: 54,
  "settled-header": 39,
  settled: 32,
  "settled-more": 32,
};

/** How close to the end of the Settled tab (in rows) scrolling asks for older threads. */
const nearEnd = 8;

/** The viewport's bottom padding (`pb-4`), below the list: the foot's free space leaves it out. */
const footPadding = 16;

/** Keys that move focus between rows: arrows, and j/k as in other lists. */
const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

/** Dragging and keyboard moves load on first use; pointing at the list warms them. */
const loadDrag = () => import("./list-drag.ts");
/** The bar for the picked threads, loaded once something is picked. */
const BulkBar = deferredComponent(() => import("./bulk-bar.tsx").then((module) => module.BulkBar));

const header =
  "mt-2.5 flex h-7 w-full items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium text-subtle-foreground focus-ring-inset transition-colors duration-(--motion-fast)";

/** A section's quiet heading: its name and how many. No rule: spacing sets the sections apart. */
function HeadingText(props: { label: string; count?: number | undefined }) {
  return (
    <>
      {props.label}
      {/* A flex gap draws the space; the text keeps it for the heading's name. */}
      {props.count !== undefined && " "}
      {props.count !== undefined && <span className="font-normal tabular-nums">{props.count}</span>}
    </>
  );
}

/** Which tab the list draws, and what that tab needs. */
export type PanelView =
  | {
      tab: "active";
      /** Searching: the settled threads that match, under their own heading at the end. */
      settledMatches?: readonly string[] | undefined;
      searching?: boolean | undefined;
    }
  | {
      tab: "settled";
      items: readonly SettledItem[];
      /** Older settled threads are loading, or the last page failed. */
      foot?: "loading" | "error" | undefined;
      /** The person scrolled near the end: load older settled threads, if any are left. */
      onNearEnd(): void;
      onRetry(): void;
    };

const activeView: PanelView = { tab: "active" };

/**
 * The Threads panel's list, virtualized, one tab at a time. Active: the Pinned group in the
 * person's own order, then Needs you, Running, Today, Yesterday, This week and Earlier under
 * quiet headings that fold, then Snoozed at the foot: below the free space while the list is
 * shorter than the sidebar, so the work in hand always comes first. Settled: settled threads
 * under week and month headings, older ones loading as the person scrolls near the end. Only
 * visible rows mount. Up and Down (or j and k) move between rows; Tab still walks each row's
 * actions. On a row, P pins or unpins it, X picks it (⌘- and Shift-click too) and Space picks it
 * up to move by keyboard; rows drag with the pointer into, within and out of the Pinned group,
 * and, when threads are sorted by hand (Settings › General › Sort threads), to any place below
 * it. A finger drags only by a pinned row's handle, so a finger on a row still scrolls the list;
 * Space or Enter on the handle starts a keyboard move. Rows that arrive (a new thread, an
 * unsnooze) rise in, rows that go (settle, snooze, archive) fade where they were, and the rest
 * slide to their new places. While the person points at the list or moves through it by
 * keyboard, rows keep their places (`useHeldRows`); the Pinned group, being theirs to order,
 * never holds, and a thread whose group changes still moves.
 */
export function ThreadList(props: {
  list: HomeList;
  view?: PanelView | undefined;
  /** Search hits for settled threads the list hasn't loaded, by thread id. */
  hits?: ReadonlyMap<string, SearchHit> | undefined;
}) {
  const { pinned, groups, snoozed } = props.list;
  const view = props.view ?? activeView;
  const { snoozedOpen, collapsed } = useOrganizerState();
  const organizer = useOrganizer();
  const current = useParams({ strict: false, select: (params) => params.threadId });
  const [moving, setMoving] = useState<readonly string[]>();
  const now = useNow();
  const rows = useMemo(() => {
    if (view.tab === "settled") return settledRows(view.items, now, view.foot);
    return activeRows(
      { pinned, groups, snoozed },
      {
        snoozedOpen,
        collapsed,
        includeUnsent: view.searching !== true,
        pinZone: moving !== undefined,
        current,
        settledMatches: view.settledMatches,
      },
    );
  }, [view, now, pinned, groups, snoozed, snoozedOpen, collapsed, moving, current]);
  const hold = useListHold(moving !== undefined);
  const held = useHeldRows(rows, hold.state, props.list.needsYou);
  const { rows: drawn, moving: sliding } = useListMotion(held, homeRowKey);
  const viewport = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef<KeyboardMove>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const selection = useHomeSelection();
  const picked = useHomeSelectionState().ids;
  // Rows of every machine: each action runs on the row's own machine (ADR 0102).
  const threads = useWindowThreads();
  const { actions } = threads;
  const keys = useResolvedKeymap();
  // oxlint-disable-next-line react-compiler/incompatible-library -- the virtualizer's callbacks are unstable by design.
  const virtualizer = useVirtualizer({
    count: drawn.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => estimates[drawn[index]?.item.kind ?? "thread"],
    paddingStart: 8,
    paddingEnd: 8,
    scrollPaddingStart: 8,
    scrollPaddingEnd: 8,
    overscan: 6,
    getItemKey: (index) => drawn[index]?.key ?? index,
  });
  useForgetGoneRows(virtualizer, drawn.length, (index) => drawn[index]?.key ?? index);
  // Near the Settled tab's end, older settled threads load: no button to press.
  const lastShown = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
  const onNearEnd = view.tab === "settled" && view.foot === undefined ? view.onNearEnd : undefined;
  useEffect(() => {
    if (onNearEnd && lastShown >= drawn.length - nearEnd) onNearEnd();
  }, [onNearEnd, lastShown, drawn.length]);
  // The foot sections sit at the sidebar's bottom while the rows above leave free space.
  const footStart = homeFootStart(drawn);
  const viewportHeight = useElementSize(viewport).height;
  const listHeight = virtualizer.getTotalSize();
  const footGap = footStart < 0 ? 0 : Math.max(0, viewportHeight - footPadding - listHeight);
  useRevealOpenThread(drawn, virtualizer.scrollToIndex, viewport);
  /** Thread ids top to bottom, as drawn: what a Shift-click range runs over. */
  const order = useMemo(
    () => drawn.flatMap((row) => (row.phase === "exit" ? [] : (homeRowThread(row.item) ?? []))),
    [drawn],
  );
  useEffect(() => selection.keepListed(order), [selection, order]);
  const mountRow = (index: number) => virtualizer.scrollToIndex(index, { align: "auto" });
  const exitFocus = useFocusAfterExit(viewport, drawn, mountRow);
  // ⌘1–9 open the first nine rows; held modifiers show each row's number.
  const jumps = useMemo(() => jumpTargets(drawn), [drawn]);
  const numbers = useMemo(() => new Map(jumps.map((id, index) => [id, index + 1])), [jumps]);
  const hints = useJumpHints();
  // Sorted by hand, the threads below Pinned are places a drag can drop at.
  const manual = useHomeSort() === "manual";
  // A drag outlives the render it started in: it reads the rows as drawn now.
  const latest = useRef({ drawn, pinned, manual });
  useLayoutEffect(() => {
    latest.current = { drawn, pinned, manual };
  });
  // One Tab stop for the whole list (a roving tabindex), kept as rows mount, move and leave.
  const lastFocused = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (listRef.current) roveListFocus(listRef.current, lastFocused.current);
  });

  /** A row's thread as this window shows it, with organize actions not yet confirmed. */
  const shownEntry = (id: string) => threads.entry(id);
  /** What a drag or keyboard move reads and does: measured rows, the pinned group, commands. */
  const host = (): DragHost | undefined => {
    const scroller = viewport.current;
    const list = listRef.current;
    if (!scroller || !list) return undefined;
    return {
      viewport: scroller,
      list,
      boxes: () =>
        virtualizer.measurementsCache.flatMap((item): RowBox[] => {
          const row = latest.current.drawn[item.index];
          if (!row || row.phase === "exit") return [];
          const kind = row.item.kind;
          // The rule closing the Pinned group is a line at its middle: Unpin lights it up.
          const middle = (item.start + item.end) / 2;
          const edge = kind === "pinned-end" ? { top: middle, bottom: middle } : undefined;
          return [
            {
              kind:
                kind === "pinned-header"
                  ? "pin-zone"
                  : kind === "pinned"
                    ? "pinned"
                    : kind === "thread" && latest.current.manual
                      ? "listed"
                      : "other",
              ...("id" in row.item ? { id: row.item.id } : {}),
              top: edge?.top ?? item.start,
              bottom: edge?.bottom ?? item.end,
            },
          ];
        }),
      pinned: () => latest.current.pinned.map((id) => ({ id, order: shownEntry(id)?.pinOrder })),
      listed: () =>
        latest.current.manual
          ? latest.current.drawn.flatMap((row) => {
              const entry =
                row.item.kind === "thread" && row.phase !== "exit"
                  ? shownEntry(row.item.id)
                  : undefined;
              return entry ? [{ id: entry.id, order: listOrderOf(entry) }] : [];
            })
          : undefined,
      entry: shownEntry,
      actions,
      setMoving,
      announce: setAnnouncement,
    };
  };
  /** The threads a drag of `id` moves: the picked ones when it is one of them, else just it. */
  const draggedWith = (id: string) => (picked.includes(id) && picked.length > 1 ? picked : [id]);

  /** Pick `id` (and the threads picked with it) up to move by keyboard. */
  const startKeyboardMove = (id: string) => {
    const ids = draggedWith(id);
    void loadDrag().then((module) => {
      const target = host();
      if (target) keyboardMove.current = module.startKeyboardMove(target, ids);
    });
  };

  const pressed = (event: KeyboardEvent, id: "home.pin" | "home.select" | "home.move") =>
    matchesChord(event.nativeEvent, parseChord(keys[id]));
  /** A keyboard move takes every key first, before a row's tooltip or menu can claim Escape. */
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable]")
    )
      return;
    const move = keyboardMove.current;
    // Escape lets the pick go (a row's tooltip, closing too, takes the key after this).
    if (!move && event.key === "Escape" && picked.length) selection.clear();
    if (!move) return;
    if (move.key(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!move.active()) keyboardMove.current = undefined;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (
      event.target.matches("[data-drag-handle]") &&
      (event.key === " " || event.key === "Enter")
    ) {
      const handled = event.target.closest<HTMLElement>("[data-thread-row]")?.dataset.threadRow;
      event.preventDefault();
      if (handled) startKeyboardMove(handled);
      return;
    }
    // The row's actions are out of the Tab order: → reaches them from the row, ← steps back.
    if (stepIntoActions(event)) return;
    // Only from a row itself: never while renaming, or inside a menu or the hover actions.
    if (!event.target.matches(rowFocusSelector)) return;
    const from = event.target.closest<HTMLElement>("[data-index]");
    if (!from) return;
    const id = event.target.closest<HTMLElement>("[data-thread-row]")?.dataset.threadRow;
    if (id && pressed(event, "home.pin")) {
      event.preventDefault();
      const shown = shownEntry(id);
      if (shown) actions.setPinned(shown, shown.pinned !== true);
      return;
    }
    if (id && pressed(event, "home.select")) {
      event.preventDefault();
      selection.toggle(id);
      return;
    }
    if (id && pressed(event, "home.move")) {
      event.preventDefault();
      startKeyboardMove(id);
      return;
    }
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey;
    const end = event.key === "Home" ? 1 : event.key === "End" ? -1 : 0;
    if (end && plain && !event.shiftKey) {
      event.preventDefault();
      const start = end > 0 ? 0 : drawn.length - 1;
      void focusRowFrom({
        viewport: viewport.current,
        rows: drawn,
        start,
        step: end,
        mount: mountRow,
      });
      return;
    }
    const step = steps[event.key];
    // Type to jump: a letter goes to the next thread whose title starts with it. Not prevented,
    // so a letter may still start a sequence ("g h").
    if (!step && plain && event.key.length === 1 && /\S/.test(event.key)) {
      const titles = drawn.map((row) => {
        const thread = row.phase === "exit" ? undefined : homeRowThread(row.item);
        return thread ? shownEntry(thread)?.title : undefined;
      });
      const at = typeAheadIndex(titles, Number(from.dataset.index), event.key);
      if (at !== undefined)
        void focusRowFrom({
          viewport: viewport.current,
          rows: drawn,
          start: at,
          step: 1,
          mount: mountRow,
        });
      return;
    }
    if (!step || !plain) return;
    event.preventDefault();
    const shifted = event.shiftKey;
    void focusListRow({
      viewport: viewport.current,
      rows: drawn,
      from: event.target,
      index: Number(from.dataset.index),
      step,
      mount: mountRow,
    }).then((next) => {
      // Shift+↑↓ picks admitted tasks, while Unsent links and disclosures only move focus.
      if (shifted && next) {
        if (id && !picked.length) selection.toggle(id);
        selection.range(order, next);
      }
    });
  };
  /** ⌘- or Ctrl-click picks a row, Shift-click a range; a plain click lets the pick go. */
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("[data-row-focus]");
    const id = link?.closest<HTMLElement>("[data-thread-row]")?.dataset.threadRow;
    if (!id) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) selection.range(order, id);
      else selection.toggle(id);
    } else if (picked.length) selection.clear();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const handle = event.target.closest("[data-drag-handle]");
    // A finger on the row scrolls the list; only the handle moves it.
    if (event.pointerType === "touch" && !handle) return;
    if (!handle && !event.target.closest("[data-row-focus]")) return;
    const id = event.target.closest<HTMLElement>("[data-thread-row]")?.dataset.threadRow;
    if (!id) return;
    const start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, id };
    const ids = draggedWith(id);
    void loadDrag().then((module) => {
      const target = host();
      if (target) module.trackPointer(target, start, ids);
    });
  };
  const movingSet = useMemo(() => new Set(moving), [moving]);
  const manyDevices = useManyDevices();
  return (
    <ManyDevices value={manyDevices}>
      <JumpKeys targets={jumps} />
      <div
        ref={viewport}
        {...hold.handlers}
        onPointerEnter={() => void loadDrag()}
        data-virtual-viewport=""
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent, black 8px, black calc(100% - 8px), transparent)",
        }}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4"
      >
        <div
          ref={listRef}
          role="list"
          aria-label="Threads"
          // Its letters jump between rows, so the composer's type-to-focus leaves them alone.
          data-type-ahead=""
          onKeyDownCapture={onKeyDownCapture}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            exitFocus.onFocus(event);
            if (!event.target.matches(rowFocusSelector)) return;
            lastFocused.current = event.target;
            roveListFocus(event.currentTarget, event.target);
          }}
          onBlur={(event) => {
            exitFocus.onBlur(event);
            const next = event.relatedTarget;
            if (next instanceof Node && event.currentTarget.contains(next)) return;
            keyboardMove.current?.cancel();
            keyboardMove.current = undefined;
          }}
          onClickCapture={onClickCapture}
          onPointerDown={onPointerDown}
          // A row is a link: the browser's own link drag would fight ours.
          onDragStart={(event) => event.preventDefault()}
          className={cn("relative w-full", sliding && "fx-list-moving")}
          style={{ height: listHeight + footGap }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const entry = drawn[item.index];
            if (!entry) return null;
            const row = entry.item;
            const leaving = entry.phase === "exit";
            const thread = homeRowThread(row);
            return (
              <div
                key={item.key}
                role={
                  leaving || row.kind === "pinned-end" || row.kind === "unsent"
                    ? "presentation"
                    : "listitem"
                }
                aria-hidden={leaving || undefined}
                inert={leaving}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className={cn(
                  // Inset from the sidebar's edges, with a small gap between rows: space, not
                  // rules, separates them.
                  "absolute inset-x-2 top-0",
                  "id" in row ? "pb-0.5" : row.kind !== "unsent" && "pb-px",
                  // While rows slide past each other each is opaque, and the one moving up
                  // passes over the others: a swap never shows two rows through each other.
                  sliding && "bg-sidebar",
                  sliding && entry.rising && "z-[1]",
                )}
                style={{
                  transform: `translateY(${item.start + (item.index >= footStart && footStart >= 0 ? footGap : 0)}px)`,
                  ...(thread && movingSet.has(thread) ? { opacity: 0.4 } : {}),
                }}
              >
                {hints && thread && !leaving && numbers.has(thread) && (
                  <span
                    aria-hidden
                    data-jump-hint=""
                    className="pointer-events-none absolute top-1.5 -left-1.5 z-[2] grid h-4 min-w-4 place-items-center rounded-xs bg-popover px-0.5 text-2xs font-medium tabular-nums text-muted-foreground shadow-[0_0_0_1px_var(--border)]"
                  >
                    {numbers.get(thread)}
                  </span>
                )}
                <div className={rowMotion(entry.phase)}>
                  {thread && machineRow(thread) ? (
                    <MachineRow id={thread} settled={row.kind === "settled"} leaving={leaving} />
                  ) : (
                    <>
                      {(row.kind === "thread" ||
                        row.kind === "pinned" ||
                        row.kind === "snoozed") && (
                        <ThreadRow threadId={row.id} settled={false} leaving={leaving} />
                      )}
                      {row.kind === "settled" && (
                        <SettledMatch id={row.id} hit={props.hits?.get(row.id)} leaving={leaving} />
                      )}
                    </>
                  )}
                  {row.kind === "settled-more" &&
                    (row.state === "loading" ? (
                      <div
                        role="status"
                        className="flex h-[30px] items-center px-2.5 text-ui text-subtle-foreground"
                      >
                        Loading older threads…
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-section-toggle=""
                        onClick={() => view.tab === "settled" && view.onRetry()}
                        className="flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-ui text-muted-foreground focus-ring-inset transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground"
                      >
                        <ArrowClockwiseIcon aria-hidden size={14} className="shrink-0" />
                        Couldn’t load older threads. Retry
                      </button>
                    ))}
                  {row.kind === "unsent" && <UnsentRows />}
                  {row.kind === "pinned-end" && <div aria-hidden className="h-2" />}
                  {row.kind === "group-header" && (
                    <button
                      type="button"
                      aria-expanded={row.open}
                      data-section-toggle=""
                      data-group={row.group}
                      onClick={() => organizer.setGroupOpen(row.group, !row.open)}
                      className={cn(
                        header,
                        row.group === "needs-you"
                          ? "text-status-needs-you hover:text-status-needs-you/80"
                          : "hover:text-muted-foreground",
                        item.index === 0 && "mt-0",
                      )}
                    >
                      <CaretDownIcon
                        aria-hidden
                        size={12}
                        className={cn(
                          "shrink-0 transition-transform duration-(--motion-base) ease-spring",
                          !row.open && "-rotate-90",
                        )}
                      />
                      <HeadingText label={activeGroupLabels[row.group]} count={row.count} />
                    </button>
                  )}
                  {row.kind === "settled-header" && (
                    <div
                      role="heading"
                      aria-level={3}
                      className={cn(header, item.index === 0 && "mt-0")}
                    >
                      {row.count === undefined ? (
                        row.label
                      ) : (
                        <>
                          {row.label} ·{" "}
                          <span className="font-normal tabular-nums">{row.count}</span>
                        </>
                      )}
                    </div>
                  )}
                  {row.kind === "pinned-header" && (
                    <div data-pin-zone="" className={cn(header, "mt-0")}>
                      {row.count ? (
                        <HeadingText label="Pinned" count={row.count} />
                      ) : (
                        <HeadingText label="Drop here to pin" />
                      )}
                    </div>
                  )}
                  {row.kind === "snoozed-header" && (
                    <button
                      type="button"
                      aria-expanded={snoozedOpen}
                      data-section-toggle=""
                      onClick={() => organizer.setSnoozedOpen(!snoozedOpen)}
                      className={cn(header, "hover:text-muted-foreground")}
                    >
                      <CaretDownIcon
                        aria-hidden
                        size={12}
                        className={cn(
                          "shrink-0 transition-transform duration-(--motion-base) ease-spring",
                          !snoozedOpen && "-rotate-90",
                        )}
                      />
                      <HeadingText label="Snoozed" count={row.count} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </div>
      {picked.length > 0 && (
        <Suspense fallback={null}>
          <BulkBar.Component />
        </Suspense>
      )}
    </ManyDevices>
  );
}

/**
 * When a thread opens (from a link, the palette, history, a reload or a send from New thread),
 * bring its row into view, and keep it there while the list moves it (a new thread's row settles
 * into its group after it first appears), until the person scrolls the list themselves.
 */
function useRevealOpenThread(
  drawn: readonly { item: HomeRow }[],
  scrollToIndex: (index: number, options: { align: "auto" }) => void,
  viewport: RefObject<HTMLElement | null>,
) {
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const revealed = useRef<{ threadId: string; index: number | undefined }>(undefined);
  const scrolled = useRef(false);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const mark = () => {
      scrolled.current = true;
    };
    const events = ["wheel", "touchmove", "pointerdown"] as const;
    for (const event of events) element.addEventListener(event, mark, { passive: true });
    return () => {
      for (const event of events) element.removeEventListener(event, mark);
    };
  }, [viewport]);
  useEffect(() => {
    if (!threadId) return;
    if (revealed.current?.threadId !== threadId) {
      revealed.current = { threadId, index: undefined };
      scrolled.current = false;
    }
    // By the thread a row shows, not its key: a row's key is encoded per kind.
    const index = drawn.findIndex((row) => homeRowThread(row.item) === threadId);
    if (index < 0 || index === revealed.current.index) return;
    if (revealed.current.index !== undefined && scrolled.current) return;
    revealed.current = { threadId, index };
    scrollToIndex(index, { align: "auto" });
  }, [threadId, drawn, scrollToIndex]);
}
