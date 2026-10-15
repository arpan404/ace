import type { PickerGroup, PickerModel } from "@ace/ui-core";
import { providerNames } from "@ace/ui-core";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, type ReactNode, type RefObject } from "react";
import { GroupProblem } from "./model-picker-rows.tsx";

/** The keyboard order includes the expandable legacy row. */
export type PickerItem =
  | { kind: "model"; model: PickerModel; group: PickerGroup | undefined }
  | { kind: "legacy"; group: PickerGroup; expanded: boolean };

type Entry =
  | { kind: "heading"; group: PickerGroup; section: number }
  | { kind: "row"; item: PickerItem; index: number };

/** Large catalogs mount only the viewport and the active keyboard row. */
export function VirtualPickerRows(props: {
  items: readonly PickerItem[];
  groups: readonly PickerGroup[];
  active: number;
  list: RefObject<HTMLDivElement | null>;
  listId: string;
  renderRow(item: PickerItem, index: number): ReactNode;
}) {
  const entries = useMemo(() => {
    const rows: Entry[] = [];
    let previous: PickerGroup | undefined;
    const populated = new Set<PickerGroup>();
    props.items.forEach((item, index) => {
      if (item.group && item.group !== previous) {
        populated.add(item.group);
        if (item.group.problems.length)
          rows.push({
            kind: "heading",
            group: item.group,
            section: props.groups.indexOf(item.group),
          });
      }
      previous = item.group;
      rows.push({ kind: "row", item, index });
    });
    // Sources without rows still explain discovery failures.
    for (const [section, group] of props.groups.entries()) {
      if (!populated.has(group)) rows.push({ kind: "heading", group, section });
    }
    return rows;
  }, [props.items, props.groups]);
  const rowAt = useMemo(
    () =>
      new Map(
        entries.flatMap((entry, index) =>
          entry.kind === "row" ? [[entry.index, index] as const] : [],
        ),
      ),
    [entries],
  );
  const active = rowAt.get(props.active) ?? -1;
  // oxlint-disable-next-line react-compiler/incompatible-library -- the virtualizer owns mutable measurements.
  const virtualizer = useVirtualizer({
    count: entries.length,
    getItemKey: (index) => {
      const entry = entries[index];
      if (!entry) return index;
      if (entry.kind === "heading") return `problems-${entry.group.id}`;
      return entry.item.kind === "legacy"
        ? `legacy-${entry.item.group.id}`
        : `${entry.item.model.instance ?? ""}-${entry.item.model.key}`;
    },
    getScrollElement: () => props.list.current,
    estimateSize: (index) => {
      const entry = entries[index];
      return entry?.kind === "heading" ? entry.group.problems.length * 48 : 44;
    },
    overscan: 4,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...(active >= 0 ? [active] : [])])].toSorted(
        (a, b) => a - b,
      ),
  });
  useEffect(() => {
    if (active >= 0) virtualizer.scrollToIndex(active, { align: "auto" });
  }, [active, props.items, virtualizer]);
  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtual) => {
        const entry = entries[virtual.index];
        if (!entry) return null;
        const group = entry.kind === "heading" ? entry.group : entry.item.group;
        return (
          <div
            key={virtual.key}
            ref={virtualizer.measureElement}
            data-index={virtual.index}
            role={group ? "group" : "presentation"}
            aria-label={group ? (group.label ?? providerNames[group.provider]) : undefined}
            aria-busy={group?.refreshing || undefined}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${virtual.start}px)` }}
          >
            {entry.kind === "row" ? (
              props.renderRow(entry.item, entry.index)
            ) : (
              <>
                {entry.group.problems.map((problem, index) => (
                  <GroupProblem
                    key={problem.message}
                    problem={problem}
                    id={`${props.listId}-problem-${entry.section}-${index}`}
                    provider={entry.group.provider}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
