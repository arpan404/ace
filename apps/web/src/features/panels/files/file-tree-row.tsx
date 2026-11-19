import { CaretRightIcon, FolderIcon, FolderOpenIcon } from "@ace/icons";
import { cleanPath, fuzzyPositions, type FolderRow } from "@ace/ui-core";
import { useEffect, useRef, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { cn } from "@/lib/cn.ts";
import { FileRowMenu } from "./file-menu.tsx";
import type { FileOperationDialog } from "./file-operation.ts";
import { Highlighted } from "./highlighted-path.tsx";

const rowClass =
  "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 group-hover/file:pr-8 group-focus-within/file:pr-8 text-left text-ui outline-none select-none transition-colors duration-(--motion-fast) hover:bg-accent focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)] aria-selected:bg-sidebar-accent";

/** The marker before a status row's words, sized like a row's caret and icon. */
function RowIndent() {
  return (
    <>
      <span aria-hidden className="size-4 shrink-0" />
      <span aria-hidden className="size-3.5 shrink-0" />
    </>
  );
}

export interface FileTreeRowViewProps {
  row: FolderRow;
  index: number;
  current: string | undefined;
  focusable: boolean;
  searching: boolean;
  query: string;
  online: boolean;
  dropTarget: string | undefined;
  onActivate(row: FolderRow, keep: boolean): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>, row: FolderRow, index: number): void;
  onFocus(key: string): void;
  onOperation(operation: FileOperationDialog): void;
  onDragOver(event: DragEvent<HTMLElement>, folder: string): void;
  onDrop(event: DragEvent<HTMLElement>, folder: string): void;
  onHoverStart(row: FolderRow): void;
  onHoverEnd(): void;
  onRetry(folder: string): void;
  onMore(folder: string): void;
}

/** One row of the lazy checkout tree: an entry, or a folder's Loading, error or Show more line. */
export function FileTreeRowView(props: FileTreeRowViewProps) {
  const { row, index } = props;
  const positions = props.searching
    ? (fuzzyPositions(props.query.trim(), cleanPath(row.key)) ?? [])
    : [];
  const nameStart = cleanPath(row.key).length - row.name.length;
  const indent = { paddingLeft: 4 + row.depth * 12 };
  if (row.kind === "loading")
    return (
      <div
        role="treeitem"
        aria-disabled="true"
        aria-level={row.depth + 1}
        tabIndex={-1}
        data-part="tree-status"
        className="flex h-8 w-full min-w-0 items-center gap-1.5 pr-2 text-ui text-muted-foreground select-none"
        style={indent}
      >
        <RowIndent />
        <span className="min-w-0 truncate">Loading…</span>
      </div>
    );
  if (row.kind === "error")
    return (
      <div
        role="treeitem"
        aria-disabled="true"
        aria-level={row.depth + 1}
        tabIndex={-1}
        data-part="tree-status"
        className="flex h-8 w-full min-w-0 items-center gap-1.5 pr-2 text-ui text-muted-foreground select-none"
        style={indent}
      >
        <RowIndent />
        <span role="alert" className="min-w-0 flex-1 truncate">
          {row.error}
        </span>
        <button
          type="button"
          className="shrink-0 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-ring"
          onClick={() => props.onRetry(row.folder ?? "")}
        >
          Try again
        </button>
      </div>
    );
  if (row.kind === "more") return <MoreRow row={row} index={index} props={props} indent={indent} />;
  const folder = row.kind === "folder";
  return (
    <FileRowMenu
      path={row.key}
      name={row.name}
      folder={folder}
      disabled={!props.online}
      tabbable={props.focusable}
      onOperation={props.onOperation}
    >
      <button
        type="button"
        role="treeitem"
        data-part="list-row"
        data-state={row.key === props.current ? "selected" : undefined}
        data-variant={folder ? "folder" : "file"}
        data-path={row.key}
        data-row={row.key}
        data-ignored={row.ignored || undefined}
        aria-level={row.depth + 1}
        aria-expanded={folder ? row.expanded : undefined}
        aria-busy={folder && row.busy ? true : undefined}
        aria-selected={row.key === props.current}
        tabIndex={props.focusable ? 0 : -1}
        title={row.key}
        onFocus={() => props.onFocus(row.key)}
        onPointerEnter={() => props.onHoverStart(row)}
        onPointerLeave={props.onHoverEnd}
        onClick={() => props.onActivate(row, false)}
        onDoubleClick={() => !folder && props.onActivate(row, true)}
        onKeyDown={(event) => props.onKeyDown(event, row, index)}
        onDragOver={folder ? (event) => props.onDragOver(event, row.key) : undefined}
        onDrop={folder ? (event) => props.onDrop(event, row.key) : undefined}
        style={indent}
        className={cn(
          rowClass,
          row.ignored ? "text-muted-foreground" : "text-foreground",
          folder && props.dropTarget === row.key && "shadow-[inset_0_0_0_1.5px_var(--ring)]",
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center">
          {folder && (
            <CaretRightIcon
              aria-hidden
              size={10}
              weight="bold"
              className={cn(
                "text-subtle-foreground transition-transform duration-(--motion-fast)",
                row.expanded && "rotate-90",
              )}
            />
          )}
        </span>
        <Icon
          icon={folder ? (row.expanded ? FolderOpenIcon : FolderIcon) : fileIcon(row.key)}
          size={14}
          className="text-subtle-foreground"
        />
        <span className="min-w-0 truncate">
          <Highlighted text={row.name} offset={nameStart} positions={positions} />
        </span>
      </button>
    </FileRowMenu>
  );
}

/**
 * A folder's Show more line. The tree only mounts it once its rows are near the view, so being
 * mounted is the sign that the person has scrolled to the end: the next page loads by itself.
 * A failed page turns this row into an error row, so a failure is retried only by Try again.
 */
function MoreRow(args: {
  row: FolderRow;
  index: number;
  props: FileTreeRowViewProps;
  indent: CSSProperties;
}) {
  const { row, index, props, indent } = args;
  const ref = useRef<HTMLButtonElement>(null);
  const onMore = useRef(props.onMore);
  onMore.current = props.onMore;
  const folder = row.folder ?? "";
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      onMore.current(folder);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onMore.current(folder);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [folder]);
  return (
    <button
      ref={ref}
      type="button"
      role="treeitem"
      data-part="list-row"
      data-variant="more"
      data-row={row.key}
      aria-level={row.depth + 1}
      tabIndex={props.focusable ? 0 : -1}
      onFocus={() => props.onFocus(row.key)}
      onClick={() => props.onMore(row.folder ?? "")}
      onKeyDown={(event) => props.onKeyDown(event, row, index)}
      style={indent}
      className={cn(rowClass, "text-muted-foreground hover:text-foreground")}
    >
      <RowIndent />
      <span className="min-w-0 truncate">Show more</span>
    </button>
  );
}
