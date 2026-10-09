import { CaretDownIcon } from "@phosphor-icons/react";
import { useSidebarStore } from "@ace/client-react";
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
} from "react";
import { rowMotion, useListMotion } from "@/lib/motion.ts";
import { homeRowKey, homeRowThread, homeRows, type HomeRow, type RowBox } from "@ace/ui-core";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { matchesChord } from "@/lib/hotkeys.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { parseChord } from "@/lib/keymap.ts";
import { ThreadRow } from "./thread-row.tsx";
import type { HomeList } from "./use-home-threads.ts";
import { useHeldRows, useListHold } from "./use-held-rows.ts";
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizeOverlay,
  useOrganizer,
  useOrganizerState,
  useThreadActions,
} from "@/features/organize/index.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";
import type { DragHost, KeyboardMove } from "./list-drag.ts";

const estimates: Record<HomeRow["kind"], number> = {
  "pinned-header": 33,
  pinned: 37,
  "pinned-end": 9,
  thread: 37,
  "settled-header": 37,
  settled: 33,
};

/** Keys that move focus between rows: arrows, and j/k as in other lists. */
const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

/** Dragging and keyboard moves load on first use; pointing at the list warms them. */
const loadDrag = () => import("./list-drag.ts");
/** The bar for the picked threads, loaded once something is picked. */
const BulkBar = deferredComponent(() => import("./bulk-bar.tsx").then((module) => module.BulkBar));

const header =
  "mt-2 flex h-7 w-full items-center gap-2 rounded-sm px-2 text-xs font-medium text-subtle-foreground outline-none transition-colors duration-(--dur-1)";

/** A section's quiet heading: its name, how many, a thin rule, and whatever closes the line. */
function HeadingText(props: { label: string; count?: number | undefined }) {
  return (
    <>
      {props.label}
      {/* A flex gap draws the space; the text keeps it for the heading's name. */}
      {props.count !== undefined && " "}
      {props.count !== undefined && <span className="font-normal tabular-nums">{props.count}</span>}
      <span aria-hidden className="h-px flex-1 bg-sidebar-border" />
    </>
  );
}

/**
 * The Home list, virtualized: the Pinned group in the person's own order, then one row per
 * thread across projects (the work in hand, then threads at rest), then the collapsible
 * Settled section (when threads settle is a
 * setting, in Settings › General). Only visible rows mount. Up and Down (or j and k) move
 * between rows; Tab still walks each row's actions. On a row, P pins or unpins it, X picks it
 * (⌘- and Shift-click too) and Space picks it up to move by keyboard; rows drag with the pointer
 * into, within and out of the Pinned group. A finger drags only by a pinned row's handle, so a
 * finger on a row still scrolls the list; Space or Enter on the handle starts a keyboard move.
 * Rows that arrive (a new thread, an unsnooze) rise in, rows that go (settle, snooze, archive)
 * fade where they were, and the rest slide to their new places. While the person points at the
 * list or moves through it by keyboard, rows keep their places (`useHeldRows`); the Pinned
 * group, being theirs to order, never holds.
 */
export function ThreadList(props: { list: HomeList }) {
  const { pinned, active, recent, settled } = props.list;
  const { settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
  const [moving, setMoving] = useState<readonly string[]>();
  const rows = useMemo(
    () =>
      homeRows({ pinned, active, recent, settled }, { settledOpen, pinZone: moving !== undefined }),
    [pinned, active, recent, settled, settledOpen, moving],
  );
  const hold = useListHold();
  const held = useHeldRows(rows, hold.state, props.list.needsYou);
  const { rows: drawn, moving: sliding } = useListMotion(held, homeRowKey);
  const viewport = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef<KeyboardMove>(undefined);
  const [announcement, setAnnouncement] = useState("");
  const selection = useHomeSelection();
  const picked = useHomeSelectionState().ids;
  const store = useSidebarStore();
  const overlay = useOrganizeOverlay();
  const actions = useThreadActions();
  const keys = useResolvedKeymap();
  // oxlint-disable-next-line react-compiler/incompatible-library -- the virtualizer's callbacks are unstable by design.
  const virtualizer = useVirtualizer({
    count: drawn.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => estimates[drawn[index]?.item.kind ?? "thread"],
    overscan: 6,
    getItemKey: (index) => drawn[index]?.key ?? index,
  });
  useForgetGoneRows(virtualizer, drawn.length, (index) => drawn[index]?.key ?? index);
  useRevealOpenThread(drawn, virtualizer.scrollToIndex);
  /** Thread ids top to bottom, as drawn: what a Shift-click range runs over. */
  const order = useMemo(
    () => drawn.flatMap((row) => (row.phase === "exit" ? [] : (homeRowThread(row.item) ?? []))),
    [drawn],
  );
  useEffect(() => selection.keepListed(order), [selection, order]);
  // A drag outlives the render it started in: it reads the rows as drawn now.
  const latest = useRef({ drawn, pinned });
  useLayoutEffect(() => {
    latest.current = { drawn, pinned };
  });

  /** A thread as this window shows it, with organize actions not yet confirmed. */
  const shownEntry = (id: string) => {
    const found = store?.thread(id);
    return found && overlay.apply(found);
  };
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
              kind: kind === "pinned-header" ? "pin-zone" : kind === "pinned" ? "pinned" : "other",
              ...("id" in row.item ? { id: row.item.id } : {}),
              top: edge?.top ?? item.start,
              bottom: edge?.bottom ?? item.end,
            },
          ];
        }),
      pinned: () => latest.current.pinned.map((id) => ({ id, order: shownEntry(id)?.pinOrder })),
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

  /** Focus the row at `index` (or the next one that isn't leaving), mounting it first if needed. */
  const focusRow = (from: number, step: number): string | undefined => {
    let index = from + step;
    while (drawn[index]?.phase === "exit") index += step;
    if (index < 0 || index >= drawn.length) return undefined;
    const target = () =>
      viewport.current?.querySelector<HTMLElement>(
        `[data-index="${index}"] [data-row-focus], [data-index="${index}"] [data-settled-toggle]`,
      );
    virtualizer.scrollToIndex(index, { align: "auto" });
    const now = target();
    if (now) now.focus();
    else requestAnimationFrame(() => target()?.focus());
    const row = drawn[index]?.item;
    return row && homeRowThread(row);
  };
  const pressed = (event: KeyboardEvent, id: "home.pin" | "home.select" | "home.move") =>
    matchesChord(event.nativeEvent, parseChord(keys[id]));
  /** A keyboard move takes every key first, before a row's tooltip or menu can claim Escape. */
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
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
    // Only from a row itself: never while renaming, or inside a menu or the hover actions.
    if (!event.target.matches("[data-row-focus], [data-settled-toggle]")) return;
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
    const step = steps[event.key];
    if (!step || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const next = focusRow(Number(from.dataset.index), step);
    // Shift+↑↓ picks every row from the last one picked to the next.
    if (event.shiftKey && next) {
      if (id && !picked.length) selection.toggle(id);
      selection.range(order, next);
    }
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
  return (
    <>
      <div
        ref={viewport}
        {...hold.handlers}
        onPointerEnter={() => {
          hold.handlers.onPointerEnter();
          void loadDrag();
        }}
        data-virtual-viewport=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
      >
        <div
          ref={listRef}
          role="list"
          aria-label="Threads"
          onKeyDownCapture={onKeyDownCapture}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
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
          style={{ height: virtualizer.getTotalSize() }}
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
                role={leaving || row.kind === "pinned-end" ? "presentation" : "listitem"}
                aria-hidden={leaving || undefined}
                inert={leaving}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className={cn(
                  "absolute inset-x-0 top-0 pb-px",
                  // While rows slide past each other each is opaque, and the one moving up
                  // passes over the others: a swap never shows two rows through each other.
                  sliding && "bg-[rgb(var(--sidebar-rgb))]",
                  sliding && entry.rising && "z-[1]",
                )}
                style={{
                  transform: `translateY(${item.start}px)`,
                  ...(thread && movingSet.has(thread) ? { opacity: 0.4 } : {}),
                }}
              >
                <div className={rowMotion(entry.phase)}>
                  {(row.kind === "thread" || row.kind === "pinned") && (
                    <ThreadRow threadId={row.id} settled={false} />
                  )}
                  {row.kind === "settled" && <ThreadRow threadId={row.id} settled />}
                  {row.kind === "pinned-end" && (
                    <div className="mx-2 my-1 h-px bg-sidebar-border" />
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
                  {row.kind === "settled-header" && (
                    <button
                      type="button"
                      aria-expanded={settledOpen}
                      data-settled-toggle=""
                      onClick={() => organizer.setSettledOpen(!settledOpen)}
                      className={cn(header, "hover:text-muted-foreground")}
                    >
                      <HeadingText label="Settled" count={row.count} />
                      <CaretDownIcon
                        aria-hidden
                        size={12}
                        className={cn(
                          "transition-transform duration-(--dur-2) ease-spring",
                          !settledOpen && "-rotate-90",
                        )}
                      />
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
    </>
  );
}

/**
 * When a thread opens (from a link, the palette, history or a reload), bring its row into view
 * once, without fighting the person's own scrolling afterwards.
 */
function useRevealOpenThread(
  drawn: readonly { item: HomeRow }[],
  scrollToIndex: (index: number, options: { align: "auto" }) => void,
) {
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const revealed = useRef<string>(undefined);
  useEffect(() => {
    if (!threadId || revealed.current === threadId) return;
    // By the thread a row shows, not its key: a row's key is encoded per kind.
    const index = drawn.findIndex((row) => homeRowThread(row.item) === threadId);
    if (index < 0) return;
    revealed.current = threadId;
    scrollToIndex(index, { align: "auto" });
  }, [threadId, drawn, scrollToIndex]);
}
