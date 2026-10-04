import { treeRows, type TreeFile, type TreeRow } from "@ace/ui-core";
import {
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { LongRows } from "@/components/virtual-rows.tsx";
import { cn } from "@/lib/cn.ts";
import { DiffStat } from "./diff-stat.tsx";

/** Past this many rows, only those near the viewport mount. */
const virtualAbove = 300;
const rowHeight = 28;

/**
 * The changed files as a tree beside the diff: filter, folders with their totals, files with
 * their own and with how many comments and whether they were viewed. Arrows move, Left and Right
 * fold, Enter jumps to the file's diff.
 */
export function FileTree(props: {
  files: readonly TreeFile[];
  /** The file last jumped to. */
  current: string | undefined;
  viewed: ReadonlySet<string>;
  comments: ReadonlyMap<string, number>;
  onJump(index: number): void;
  className?: string;
}) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () => treeRows(props.files, { collapsed, filter }),
    [props.files, collapsed, filter],
  );
  const [focused, setFocused] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const at = Math.min(focused, Math.max(0, rows.length - 1));
  const fold = (key: string, open: boolean) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  const focus = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocused(next);
    list.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus();
  };
  const activate = (row: TreeRow) =>
    row.kind === "folder" ? fold(row.key, !row.open) : props.onJump(row.index);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, row: TreeRow, index: number) => {
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: rows.length - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      focus(target);
    } else if (event.key === "ArrowRight" && row.kind === "folder") {
      event.preventDefault();
      if (row.open) focus(index + 1);
      else fold(row.key, true);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.kind === "folder" && row.open) fold(row.key, false);
      // Else to the parent folder: the nearest row above that sits a level up.
      else
        focus(rows.findLastIndex((other, position) => position < index && other.depth < row.depth));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(row);
    }
  };
  return (
    <nav aria-label="Changed files" className={cn("flex min-h-0 flex-col", props.className)}>
      <div className="shrink-0 p-2">
        <label className="flex h-8 items-center gap-2 rounded-md bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)] px-2.5 shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[0_0_0_2px_var(--ring)]">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
          <input
            type="search"
            aria-label="Filter changed files"
            placeholder="Filter files"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setFocused(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && rows.length) {
                event.preventDefault();
                focus(0);
              } else if (event.key === "Escape" && filter) {
                event.preventDefault();
                setFilter("");
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setFilter("")}
              className="h-5 shrink-0 rounded-xs px-1 text-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            >
              Clear
            </button>
          )}
        </label>
      </div>
      {rows.length === 0 ? (
        <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
          No changed file matches “{filter.trim()}”.
        </p>
      ) : (
        <div
          ref={list}
          role="tree"
          aria-label="Changed files"
          className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
        >
          <LongRows
            items={rows}
            virtualAbove={virtualAbove}
            rowKey={(row) => `${row.kind}:${row.key}`}
            estimate={rowHeight}
            render={(row, index) => (
              <TreeRowView
                row={row}
                index={index}
                tabbable={index === at}
                current={row.kind === "file" && row.key === props.current}
                viewed={row.kind === "file" && props.viewed.has(row.key)}
                comments={row.kind === "file" ? (props.comments.get(row.key) ?? 0) : 0}
                onActivate={() => {
                  setFocused(index);
                  activate(row);
                }}
                onKeyDown={(event) => onKeyDown(event, row, index)}
              />
            )}
          />
        </div>
      )}
    </nav>
  );
}

function TreeRowView(props: {
  row: TreeRow;
  index: number;
  tabbable: boolean;
  current: boolean;
  viewed: boolean;
  comments: number;
  onActivate(): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}) {
  const { row } = props;
  const folder = row.kind === "folder";
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={folder ? row.open : undefined}
      aria-selected={props.current}
      aria-label={
        folder
          ? `${row.name}, ${row.files} ${row.files === 1 ? "file" : "files"}`
          : `${row.key}${props.viewed ? ", viewed" : ""}${props.comments ? `, ${props.comments} ${props.comments === 1 ? "comment" : "comments"}` : ""}`
      }
      data-row={props.index}
      tabIndex={props.tabbable ? 0 : -1}
      onClick={props.onActivate}
      onKeyDown={props.onKeyDown}
      style={{ paddingLeft: 6 + row.depth * 14 }}
      className={cn(
        "flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-md pr-2 text-sm text-muted-foreground outline-none select-none hover:bg-accent hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
        props.current && "bg-accent text-foreground",
      )}
    >
      <span className="grid w-3 shrink-0 place-items-center">
        {folder && (
          <CaretRightIcon
            aria-hidden
            size={10}
            className={cn(
              "text-subtle-foreground transition-transform duration-(--dur-1)",
              row.open && "rotate-90",
            )}
          />
        )}
      </span>
      <Icon
        icon={folder ? (row.open ? FolderOpenIcon : FolderIcon) : FileIcon}
        size={14}
        className="text-subtle-foreground"
      />
      <span className={cn("min-w-0 flex-1 truncate", !folder && "font-mono text-[12px]")}>
        {row.name}
      </span>
      {props.comments > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-subtle-foreground tabular-nums">
          <ChatCircleIcon aria-hidden size={12} />
          {props.comments}
        </span>
      )}
      {props.viewed && (
        <CheckIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      )}
      <DiffStat additions={row.additions} deletions={row.deletions} className="shrink-0" />
    </div>
  );
}
