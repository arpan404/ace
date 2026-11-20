import { CaretRightIcon, FolderIcon, FolderOpenIcon } from "@ace/icons";
import { cleanPath, fuzzyPositions, type FolderRow } from "@ace/ui-core";
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { ProviderKind } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { fileIcon } from "@/components/file-icon.ts";
import { cn } from "@/lib/cn.ts";
import { FileRowMenu } from "./file-menu.tsx";
import { FileRowItems } from "./file-row-items.tsx";
import type { OpenHow, TreeCommands } from "./tree-commands.ts";
import { entryOf } from "./tree-row-keys.ts";
import type { TreeDrag } from "./use-tree-drag.ts";
import { Highlighted } from "./highlighted-path.tsx";
import { RenameField, type InlineRename } from "./file-tree-rename.tsx";

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

/** An agent changed this file recently and the person hasn't looked since (workbench spec 21). */
export interface RowMark {
  /** "Claude Code", or another thread's title. */
  name: string;
  provider: ProviderKind | undefined;
  /** How long ago: "just now", "4m". */
  age: string;
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
  /** `at`: a click's time, so a second click on a file soon after keeps it. */
  onActivate(row: FolderRow, how: OpenHow, at?: number): void;
  /** In the tree's selection. */
  selected: boolean;
  /** Cut, waiting to be pasted somewhere else. */
  cut: boolean;
  /** Where the row sits among its siblings, for a screen reader. */
  place: { position: number; size: number } | undefined;
  /** A click on the row, with its modifiers: pick, toggle or extend the selection. */
  onPick(row: FolderRow, event: MouseEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>, row: FolderRow, index: number): void;
  onFocus(key: string): void;
  /** Put the keyboard back on a row (a rename given up). */
  onRefocus(key: string): void;
  commands: TreeCommands;
  /** Dragging rows to move them, and dropping on them; unset while the tree is a search. */
  drag: TreeDrag | undefined;
  onHoverStart(row: FolderRow): void;
  onHoverEnd(): void;
  onRetry(folder: string): void;
  onMore(folder: string): void;
  /** This row is being renamed: its name is a field. */
  renaming?: InlineRename | undefined;
  /** The agent's mark, as the file's tab carries it. */
  mark?: RowMark | undefined;
}

function rowDescription(cut: boolean, mark: RowMark | undefined): string | undefined {
  const changed = mark && `Changed by ${mark.name} · ${mark.age}`;
  if (cut) return changed ? `Cut. ${changed}` : "Cut";
  return changed;
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
        aria-posinset={props.place?.position}
        aria-setsize={props.place?.size}
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
        aria-posinset={props.place?.position}
        aria-setsize={props.place?.size}
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
  if (props.renaming)
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected
        aria-expanded={folder ? row.expanded : undefined}
        data-part="list-row"
        data-path={row.key}
        data-row={row.key}
        style={indent}
        className="flex min-h-8 w-full min-w-0 items-center gap-1.5 pr-2 text-ui"
      >
        <span aria-hidden className="size-4 shrink-0" />
        <Icon
          icon={folder ? (row.expanded ? FolderOpenIcon : FolderIcon) : fileIcon(row.key)}
          size={14}
          className="shrink-0 self-start mt-2 text-subtle-foreground"
        />
        <RenameField
          name={row.name}
          folder={folder}
          onCommit={props.renaming.commit}
          onCancel={(keyboard) => {
            props.renaming?.cancel();
            if (keyboard) requestAnimationFrame(() => props.onRefocus(row.key));
          }}
        />
      </div>
    );
  return (
    <FileRowMenu
      name={row.name}
      tabbable={props.focusable}
      items={<FileRowItems entry={entryOf(row)} commands={props.commands} />}
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
        aria-posinset={props.place?.position}
        aria-setsize={props.place?.size}
        aria-expanded={folder ? row.expanded : undefined}
        aria-busy={folder && row.busy ? true : undefined}
        aria-selected={props.selected}
        aria-description={rowDescription(props.cut, props.mark)}
        tabIndex={props.focusable ? 0 : -1}
        title={
          props.mark ? `${row.key}, changed by ${props.mark.name} · ${props.mark.age}` : row.key
        }
        onFocus={() => props.onFocus(row.key)}
        onPointerEnter={() => props.onHoverStart(row)}
        onPointerLeave={props.onHoverEnd}
        onClick={(event) => props.onPick(row, event)}
        onDoubleClick={() => !folder && props.onActivate(row, "keep")}
        // A middle click opens a file in a tab of its own, as a browser opens a link.
        onMouseDown={(event) => event.button === 1 && event.preventDefault()}
        onAuxClick={(event) => {
          if (event.button !== 1 || folder) return;
          event.preventDefault();
          props.onActivate(row, "tab");
        }}
        onKeyDown={(event) => props.onKeyDown(event, row, index)}
        {...props.drag?.row(row)}
        style={indent}
        className={cn(
          rowClass,
          row.ignored ? "text-muted-foreground" : "text-foreground",
          props.cut && "opacity-60",
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
        {props.mark && (
          <span
            aria-hidden
            data-agent-mark
            className="ml-auto grid size-[18px] shrink-0 place-items-center"
          >
            {props.mark.provider ? (
              <ProviderIcon provider={props.mark.provider} size={12} decorative />
            ) : (
              <span className="size-1.5 rounded-full bg-status-working" />
            )}
          </span>
        )}
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
  useEffect(() => {
    onMore.current = props.onMore;
  });
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
      aria-posinset={props.place?.position}
      aria-setsize={props.place?.size}
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
