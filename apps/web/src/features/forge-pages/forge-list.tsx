import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { VirtualList, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import { GroupHeader } from "./row-parts.tsx";

/** A group of a list page: its heading (unless it is the only, unnamed one) and its rows. */
export interface ForgeGroup<R> {
  id: string;
  label: string;
  icon: IconGlyph;
  /** Its count in words ("3", "2 of 12"); none while unknown. */
  count: string | undefined;
  /** Drawn with its heading: false for a list with one group that needs no name. */
  headed: boolean;
  rows: readonly R[];
}

type Entry<R> =
  | { kind: "group"; group: ForgeGroup<R> }
  | { kind: "row"; row: R; group: string; last: boolean };

/** A group's heading line: its words, with 20px above and 6px below. */
const headingHeight = 42;

/**
 * The rows of a Code review list (Pull requests, Issues, Inbox) across the main column: its
 * groups' headings and rows as one flat list, so thousands of rows mount a screenful, then Show
 * more while GitHub has more pages. ↑/↓, Home/End and letters reach every row, mounted or not.
 */
export function ForgeList<R>(props: {
  /** The list's name for assistive tech ("Pull requests"). */
  label: string;
  /** A newer page is on its way: the rows dim and the list says it is busy. */
  stale: boolean;
  groups: readonly ForgeGroup<R>[];
  rowKey(row: R): string;
  /** A row's title, for type-to-jump. */
  rowTitle(row: R): string;
  /** A row's usual height in px; rows are measured once mounted. */
  estimate: number;
  renderRow(row: R, group: string, last: boolean): ReactNode;
  /** GitHub has more pages: Show more asks for the next. */
  onMore: (() => void) | undefined;
  /**
   * Triage keys: j and k move between rows as ↓ and ↑ do, and any other letter goes to
   * `onRowKey` with the focused row; true means it was handled.
   */
  onRowKey?: ((row: R, key: string) => boolean) | undefined;
}) {
  const { rowKey, rowTitle } = props;
  const entries: Entry<R>[] = [];
  for (const group of props.groups) {
    if (group.headed) entries.push({ kind: "group", group });
    group.rows.forEach((row, index) =>
      entries.push({ kind: "row", row, group: group.id, last: index === group.rows.length - 1 }),
    );
  }
  const handle = useRef<VirtualRowsHandle>(null);
  const keys = useViewListKeys<HTMLElement>({
    count: entries.length,
    titleAt: (index) => {
      const entry = entries[index];
      return entry?.kind === "row" ? rowTitle(entry.row) : undefined;
    },
    reveal: (index) => handle.current?.scrollToIndex(index, "auto"),
  });
  const onMore = props.onMore;
  const nav = useRef<HTMLElement | null>(null);
  const rowElement = (index: number) =>
    nav.current?.querySelector<HTMLElement>(`[data-index="${index}"] [data-view-row]`);
  /** Focus a row now when it is mounted, else once it scrolls in. */
  const focusAt = (index: number) => {
    const now = rowElement(index);
    if (now) now.focus({ preventScroll: true });
    else requestAnimationFrame(() => rowElement(index)?.focus({ preventScroll: true }));
  };
  const rowAt = (index: number, step: 1 | -1) => {
    for (let at = index + step; at >= 0 && at < entries.length; at += step)
      if (entries[at]?.kind === "row") return at;
    return undefined;
  };
  const onRowKey = props.onRowKey;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (onRowKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.defaultPrevented) {
      const at =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>("[data-index]")
          : null;
      const index = at ? Number(at.dataset["index"]) : Number.NaN;
      const entry = entries[index];
      if (entry?.kind === "row") {
        if (event.key === "j" || event.key === "k") {
          event.preventDefault();
          const target = rowAt(index, event.key === "j" ? 1 : -1);
          if (target === undefined) return;
          handle.current?.scrollToIndex(target, "auto");
          focusAt(target);
          return;
        }
        if (event.key.length === 1) {
          // The row may leave (done): focus moves on to the next one first, as triage does.
          const next = rowAt(index, 1) ?? rowAt(index, -1);
          if (onRowKey(entry.row, event.key)) {
            event.preventDefault();
            if (next !== undefined) focusAt(next);
            return;
          }
        }
      }
    }
    keys.onKeyDown(event);
  };
  return (
    <nav
      aria-label={props.label}
      aria-busy={props.stale}
      ref={(element) => {
        nav.current = element;
        keys.ref(element);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "@container/list pb-6",
        props.stale && "opacity-60 transition-opacity duration-(--motion-fast)",
      )}
    >
      <VirtualList
        label={props.label}
        items={entries}
        handle={handle}
        rowKey={(entry) =>
          entry.kind === "group" ? `group:${entry.group.id}` : `row:${rowKey(entry.row)}`
        }
        estimate={(entry) => (entry.kind === "group" ? headingHeight : props.estimate)}
        render={(entry) =>
          entry.kind === "group" ? (
            <GroupHeader
              icon={entry.group.icon}
              label={entry.group.label}
              count={entry.group.count}
            />
          ) : (
            props.renderRow(entry.row, entry.group, entry.last)
          )
        }
      />
      {onMore && (
        <div className="px-(--forge-gutter) pt-2">
          <Button size="sm" variant="ghost" onClick={onMore}>
            Show more
          </Button>
        </div>
      )}
    </nav>
  );
}
