import { CaretDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn.ts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { rowMotion, useListMotion } from "@/lib/motion.ts";
import { type Arrangement } from "@ace/ui-core";
import { AutoSettleNote } from "./auto-settle-note.tsx";
import { SettledRow } from "./settled-row.tsx";
import { HomeMachine, useHomeMachine } from "./thread-details.ts";
import { ThreadRow } from "./thread-row.tsx";
import { useOrganizer, useOrganizerState } from "./use-organizer.ts";

type Row =
  | { kind: "thread"; id: string }
  | { kind: "settled-header"; count: number }
  | { kind: "settled"; id: string }
  | { kind: "rule" };

const estimates: Record<Row["kind"], number> = {
  thread: 74,
  "settled-header": 40,
  settled: 30,
  rule: 52,
};
const keyOf = (row: Row) => (row.kind === "thread" || row.kind === "settled" ? row.id : row.kind);

/**
 * The Home list, virtualized: cards in Home order, then the collapsible Settled section with
 * compact rows and the auto-settle rule. Only visible rows mount. Rows that arrive (a new thread,
 * an unsnooze) rise in, rows that go (settle, snooze, archive) fade where they were, and the
 * rest slide to their new places.
 */
export function ThreadList(props: { arrangement: Arrangement }) {
  const { active, settled } = props.arrangement;
  const { settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
  const home = useHomeMachine();
  const rows = useMemo<Row[]>(
    () => [
      ...active.map((id): Row => ({ kind: "thread", id })),
      { kind: "settled-header", count: settled.length },
      ...(settledOpen
        ? [...settled.map((id): Row => ({ kind: "settled", id })), { kind: "rule" } as const]
        : []),
    ],
    [active, settled, settledOpen],
  );
  const { rows: drawn, moving } = useListMotion(rows, keyOf);
  const viewport = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react-compiler/incompatible-library -- the virtualizer's callbacks are unstable by design.
  const virtualizer = useVirtualizer({
    count: drawn.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => estimates[drawn[index]?.item.kind ?? "thread"],
    overscan: 6,
    getItemKey: (index) => drawn[index]?.key ?? index,
  });
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
                className="absolute inset-x-0 top-0 pb-px"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <div className={rowMotion(entry.phase)}>
                  {row.kind === "thread" && <ThreadRow threadId={row.id} />}
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
  drawn: readonly { key: string }[],
  scrollToIndex: (index: number, options: { align: "auto" }) => void,
) {
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  const revealed = useRef<string>(undefined);
  useEffect(() => {
    if (!threadId || revealed.current === threadId) return;
    const index = drawn.findIndex((row) => row.key === threadId);
    if (index < 0) return;
    revealed.current = threadId;
    scrollToIndex(index, { align: "auto" });
  }, [threadId, drawn, scrollToIndex]);
}
