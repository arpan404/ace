import { CaretDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn.ts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { rowMotion, useListMotion } from "@/lib/motion.ts";
import { homeRowKey, homeRowThread, homeRows, type HomeRow } from "@ace/ui-core";
import { SettledRow } from "./settled-row.tsx";
import { HomeMachine, useHomeMachine } from "./thread-details.ts";
import { ThreadRow } from "./thread-row.tsx";
import type { HomeList } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";

const estimates: Record<HomeRow["kind"], number> = {
  thread: 69,
  "settled-header": 40,
  settled: 31,
};

/** Keys that move focus between rows: arrows, and j/k as in other lists. */
const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };

/**
 * The Home list, virtualized: one task row per thread across projects, pinned first, then the
 * collapsible Settled section (when threads settle is a setting, in Settings › General). Only
 * visible rows mount. Up and Down (or j and k) move between rows; Tab still walks each row's
 * actions.
 * Rows that arrive (a new thread, an unsnooze) rise in, rows that go (settle, snooze, archive)
 * fade where they were, and the rest slide to their new places.
 */
export function ThreadList(props: { list: HomeList }) {
  const { active, settled } = props.list;
  const { settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
  const home = useHomeMachine();
  const rows = useMemo(
    () => homeRows(active, settled, { settledOpen }),
    [active, settled, settledOpen],
  );
  const { rows: drawn, moving } = useListMotion(rows, homeRowKey);
  const viewport = useRef<HTMLDivElement>(null);
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
  /** Focus the row at `index` (or the next one that isn't leaving), mounting it first if needed. */
  const focusRow = (from: number, step: number) => {
    let index = from + step;
    while (drawn[index]?.phase === "exit") index += step;
    if (index < 0 || index >= drawn.length) return;
    const target = () =>
      viewport.current?.querySelector<HTMLElement>(
        `[data-index="${index}"] [data-row-focus], [data-index="${index}"] [data-settled-toggle]`,
      );
    virtualizer.scrollToIndex(index, { align: "auto" });
    const now = target();
    if (now) now.focus();
    else requestAnimationFrame(() => target()?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = steps[event.key];
    if (!step || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLElement)) return;
    // Only from a row itself: never while renaming, or inside a menu or the hover actions.
    if (!event.target.matches("[data-row-focus], [data-settled-toggle]")) return;
    const from = event.target.closest<HTMLElement>("[data-index]");
    if (!from) return;
    event.preventDefault();
    focusRow(Number(from.dataset.index), step);
  };
  return (
    <HomeMachine value={home}>
      <div
        ref={viewport}
        data-virtual-viewport=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
      >
        <div
          role="list"
          onKeyDown={onKeyDown}
          className={cn("relative w-full", moving && "fx-list-moving")}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const entry = drawn[item.index];
            if (!entry) return null;
            const row = entry.item;
            const leaving = entry.phase === "exit";
            return (
              <div
                key={item.key}
                role={leaving ? "presentation" : "listitem"}
                aria-hidden={leaving || undefined}
                inert={leaving}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className={cn(
                  "absolute inset-x-0 top-0 pb-0.5",
                  // While rows slide past each other each is opaque, and the one moving up
                  // passes over the others: a swap never shows two rows through each other.
                  moving && "bg-[rgb(var(--sidebar-rgb))]",
                  moving && entry.rising && "z-[1]",
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className={rowMotion(entry.phase)}>
                  {row.kind === "thread" && <ThreadRow threadId={row.id} />}
                  {row.kind === "settled" && <SettledRow threadId={row.id} />}
                  {row.kind === "settled-header" && (
                    <button
                      type="button"
                      aria-expanded={settledOpen}
                      data-settled-toggle=""
                      onClick={() => organizer.setSettledOpen(!settledOpen)}
                      className="mt-3 mb-0.5 flex w-full items-center gap-2 rounded-sm px-2.5 py-[5px] text-xs font-medium text-subtle-foreground outline-none transition-colors duration-(--dur-1) after:h-px after:flex-1 after:bg-sidebar-border hover:text-muted-foreground"
                    >
                      Settled ({row.count})
                      <CaretDownIcon
                        aria-hidden
                        size={14}
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
      </div>
    </HomeMachine>
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
