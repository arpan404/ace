import { CaretDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn.ts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { rowMotion, useListMotion } from "@/lib/motion.ts";
import { homeRowKey, homeRowThread, homeRows, type HomeRow } from "@ace/ui-core";
import { AutoSettleNote } from "./auto-settle-note.tsx";
import { FolderRow, PinnedLabel, ShowMore } from "./folder-rows.tsx";
import { useFolders } from "./folders.ts";
import { SettledRow } from "./settled-row.tsx";
import { HomeMachine, useHomeMachine } from "./thread-details.ts";
import { ThreadRow } from "./thread-row.tsx";
import type { HomeList } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { useForgetGoneRows } from "@/lib/virtual-cache.ts";

const estimates: Record<HomeRow["kind"], number> = {
  "pinned-label": 36,
  pinned: 31,
  folder: 31,
  thread: 31,
  more: 37,
  "settled-header": 40,
  settled: 31,
  rule: 52,
};

/**
 * The Home list, virtualized: Pinned, then a folder per project (its first threads, then Show
 * more), then the collapsible Settled section and the auto-settle rule. Only visible rows mount.
 * Rows that arrive (a new thread, an unsnooze) rise in, rows that go (settle, snooze, archive)
 * fade where they were, and the rest slide to their new places.
 */
export function ThreadList(props: { list: HomeList }) {
  const { groups, settled } = props.list;
  const { settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
  const folders = useFolders();
  const open = useParams({ strict: false, select: (params) => params.threadId });
  const home = useHomeMachine();
  const rows = useMemo(
    () =>
      homeRows(groups, settled, {
        closed: folders.state.closed,
        showingAll: folders.state.showingAll,
        open,
        settledOpen,
      }),
    [groups, settled, folders.state, open, settledOpen],
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
  return (
    <HomeMachine value={home}>
      <div
        ref={viewport}
        data-virtual-viewport=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
      >
        <div
          role="list"
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
                  "absolute inset-x-0 top-0 pb-px",
                  // While rows slide past each other each is opaque, and the one moving up
                  // passes over the others: a swap never shows two rows through each other.
                  moving && "bg-[rgb(var(--sidebar-rgb))]",
                  moving && entry.rising && "z-[1]",
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className={rowMotion(entry.phase)}>
                  {row.kind === "pinned-label" && <PinnedLabel />}
                  {row.kind === "pinned" && <ThreadRow threadId={row.id} pinned />}
                  {row.kind === "folder" && (
                    <FolderRow
                      project={row.project}
                      open={row.open}
                      needsYou={row.needsYou}
                      onToggle={() => folders.folders.toggleOpen(row.project)}
                    />
                  )}
                  {row.kind === "thread" && <ThreadRow threadId={row.id} />}
                  {row.kind === "more" && (
                    <ShowMore
                      project={row.project}
                      showingAll={row.showingAll}
                      onToggle={() => folders.folders.toggleShowingAll(row.project)}
                    />
                  )}
                  {row.kind === "settled" && <SettledRow threadId={row.id} />}
                  {row.kind === "rule" && <AutoSettleNote />}
                  {row.kind === "settled-header" && (
                    <button
                      type="button"
                      aria-expanded={settledOpen}
                      onClick={() => organizer.setSettledOpen(!settledOpen)}
                      className="mt-3 mb-0.5 flex w-full items-center gap-2 rounded-[7px] px-2.5 py-[5px] text-xs font-medium text-subtle-foreground outline-none transition-colors duration-(--dur-1) after:h-px after:flex-1 after:bg-sidebar-border hover:text-muted-foreground"
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
