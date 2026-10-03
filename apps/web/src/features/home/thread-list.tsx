import { CaretDownIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn.ts";
import { useMemo, useRef } from "react";
import { type Arrangement } from "@ace/ui-core";
import { AutoSettleNote } from "./auto-settle-note.tsx";
import { SettledRow } from "./settled-row.tsx";
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
 * compact rows and the auto-settle rule. Only visible rows mount.
 */
export function ThreadList(props: { arrangement: Arrangement }) {
  const { active, settled } = props.arrangement;
  const { settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
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
  const viewport = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react-compiler/incompatible-library -- the virtualizer's callbacks are unstable by design.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => estimates[rows[index]?.kind ?? "thread"],
    overscan: 6,
    getItemKey: (index) => {
      const row = rows[index];
      return row ? keyOf(row) : index;
    },
  });
  return (
    <div
      ref={viewport}
      data-virtual-viewport=""
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4"
    >
      <div role="list" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              role="listitem"
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute inset-x-0 top-0 pb-px"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "thread" && <ThreadRow threadId={row.id} />}
              {row.kind === "settled" && <SettledRow threadId={row.id} />}
              {row.kind === "rule" && <AutoSettleNote />}
              {row.kind === "settled-header" && (
                <button
                  type="button"
                  aria-expanded={settledOpen}
                  onClick={() => organizer.setSettledOpen(!settledOpen)}
                  className="mt-3 mb-0.5 flex w-full items-center gap-2 rounded-[7px] px-2.5 py-[5px] text-xs font-medium text-subtle-foreground outline-none transition-colors duration-150 after:h-px after:flex-1 after:bg-sidebar-border hover:text-muted-foreground"
                >
                  Settled ({row.count})
                  <CaretDownIcon
                    aria-hidden
                    size={14}
                    className={cn(
                      "transition-transform duration-200 ease-spring",
                      !settledOpen && "-rotate-90",
                    )}
                  />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
