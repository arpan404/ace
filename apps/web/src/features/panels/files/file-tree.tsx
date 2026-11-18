import { useConnectionState } from "@ace/client-react";
import {
  ancestorFolders,
  buildFileTree,
  checkoutTreeRows,
  folderKey,
  openedFolders,
  pathParts,
  revealingFolders,
  toggledFolders,
  type FolderRow,
} from "@ace/ui-core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { attachWorkspaceScroll } from "@/lib/workspace/index.ts";
import type { FileOperationDialog } from "./file-operation.ts";
import { FileTreeRowView } from "./file-tree-row.tsx";
import { FileTreeSearch } from "./file-tree-search.tsx";
import { useCheckoutSearch, usePrefetchFile } from "./use-checkout.ts";
import { useFolderTree } from "./use-folder-tree.ts";

/** Past this many rows, only those near the viewport mount: each row carries two menus. */
const virtualAbove = 200;
/** How long the pointer rests on a file before it's read ahead: passing over rows reads nothing. */
const prefetchDelay = 80;

/** The file tree of a thread's checkout: a folder is listed when it opens, a page at a time. */
export function FileTree(props: {
  threadId: string;
  onOperation(operation: FileOperationDialog): void;
  current: string | undefined;
  onOpen(path: string, keep: boolean): void;
  onUpload(files: readonly File[], folder: string): void;
  /** The filter's text, owned by the tab so its breadcrumb can narrow it to a folder. */
  query: string;
  onQuery(query: string): void;
  /** Folders the person opened; unset, only the current file's ancestors stand open. */
  expanded: readonly string[] | undefined;
  onExpanded(folders: string[]): void;
  /** Where the tree was scrolled, owned by the tab so opening a file keeps it. */
  scrollTop?: number | undefined;
  onScroll?(scrollTop: number): void;
  /** Shown under the tree: an upload in progress or what stopped it. */
  footer?: ReactNode;
}) {
  const online = useConnectionState() === "ready";
  const { query, onQuery: setQuery } = props;
  const search = useCheckoutSearch(props.threadId, query);
  const searching = query.trim().length > 0;
  const results = searching ? search.data : undefined;
  const found = useMemo(() => buildFileTree(results ?? []), [results]);
  // Folders start folded: a checkout holds far more than a screen. The tab keeps which folders
  // the person opened; unset, only the current file's parents stand open so it shows. Searching
  // ignores folding, so every match is visible.
  const currentPath = props.current;
  const onExpanded = props.onExpanded;
  const opened = useMemo(
    () => openedFolders(props.expanded, currentPath),
    [props.expanded, currentPath],
  );
  // A file opened from elsewhere (quick open, a tab) is revealed by opening its ancestors, each
  // of which lists on the way. Folding one by hand stays folded until another file is revealed.
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (revealed.current === currentPath) return;
    revealed.current = currentPath;
    const missing = revealingFolders(opened, currentPath);
    if (missing.length) onExpanded([...opened, ...missing]);
  }, [currentPath, opened, onExpanded]);
  const tree = useFolderTree({ threadId: props.threadId, expanded: opened, paused: searching });
  const searchRows = useMemo<FolderRow[]>(
    () =>
      checkoutTreeRows(found, () => true).map((row) => ({
        key: row.node.path,
        kind: row.node.kind === "folder" ? "folder" : "file",
        name: row.node.name,
        depth: row.depth,
        expanded: row.expanded,
        busy: false,
        ignored: false,
      })),
    [found],
  );
  const rows = searching ? searchRows : tree.rows;
  const [focusKey, setFocusKey] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const navigable = useMemo(
    () => rows.filter((row) => row.kind !== "loading" && row.kind !== "error"),
    [rows],
  );
  const focusable = navigable.some((row) => row.key === focusKey)
    ? focusKey
    : (navigable.find((row) => row.key === currentPath)?.key ?? navigable[0]?.key);

  const toggle = (folder: string, expand?: boolean) => {
    const shouldOpen = expand ?? !opened.has(folder);
    props.onExpanded([...toggledFolders(opened, folder, shouldOpen)]);
  };
  const rowsHandle = useRef<VirtualRowsHandle>(null);
  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    const find = () => list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
    const row = find();
    if (row) return row.focus();
    // A long tree mounts only the rows near the view: bring the row in, then focus it.
    rowsHandle.current?.scrollToIndex(rows.findIndex((each) => each.key === key));
    requestAnimationFrame(() => find()?.focus());
  };
  // A folder whose cursor went stale restarts; focus goes back to that folder's row.
  const focusRowRef = useRef(focusRow);
  useEffect(() => {
    focusRowRef.current = focusRow;
  });
  const restart = tree.focus;
  useEffect(() => {
    if (restart?.folder) focusRowRef.current(folderKey(restart.folder));
  }, [restart]);
  /** The next row a key press may land on, skipping a folder's loading or error line. */
  const step = (index: number, delta: number) => {
    for (let at = index + delta; at >= 0 && at < rows.length; at += delta) {
      const candidate = rows[at];
      if (candidate && candidate.kind !== "loading" && candidate.kind !== "error") return candidate;
    }
    return undefined;
  };
  // A file the pointer rests on is read ahead, so clicking it shows it at once.
  const prefetchFile = usePrefetchFile(props.threadId);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverStart = (row: FolderRow) => {
    clearTimeout(hover.current);
    if (row.kind !== "file" || row.key === currentPath || !online) return;
    hover.current = setTimeout(() => prefetchFile(row.key), prefetchDelay);
  };
  const hoverEnd = () => clearTimeout(hover.current);
  useEffect(() => () => clearTimeout(hover.current), []);
  const activate = (row: FolderRow, keep: boolean) => {
    if (row.kind === "more") {
      tree.showMore(row.folder ?? "");
      return;
    }
    if (row.kind === "folder") {
      // A folder found by search narrows the search to it; one in the tree opens or closes.
      if (searching) setQuery(row.key);
      else toggle(row.key);
      return;
    }
    if (row.kind === "file") props.onOpen(row.key, keep);
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, row: FolderRow, index: number) => {
    if (row.kind === "loading" || row.kind === "error") return;
    if (
      row.kind !== "more" &&
      online &&
      (event.key === "F2" ||
        event.key === "Delete" ||
        event.key === "Backspace" ||
        ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m"))
    ) {
      event.preventDefault();
      props.onOperation({
        kind:
          event.key === "F2"
            ? "rename"
            : event.key === "Delete" || event.key === "Backspace"
              ? "delete"
              : "move",
        path: row.key,
      });
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        focusRow(step(index, 1)?.key);
        break;
      case "ArrowUp":
        if (index === 0) list.current?.parentElement?.querySelector("input")?.focus();
        else focusRow(step(index, -1)?.key);
        break;
      case "Home":
        focusRow(navigable[0]?.key);
        break;
      case "End":
        focusRow(navigable.at(-1)?.key);
        break;
      case "ArrowRight":
        if (row.kind !== "folder") return;
        if (!row.expanded) toggle(row.key, true);
        else focusRow(step(index, 1)?.key);
        break;
      case "ArrowLeft":
        if (row.kind === "more") {
          focusRow(row.folder ? folderKey(row.folder) : undefined);
          break;
        }
        if (row.kind === "folder" && row.expanded) toggle(row.key, false);
        else focusRow(ancestorFolders(row.key).at(-1));
        break;
      case "Enter":
        activate(row, true);
        break;
      case " ":
        activate(row, false);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  const currentFolder = currentPath ? pathParts(currentPath).folder : "";
  const drop = (event: DragEvent<HTMLElement>, folder: string) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropTarget(undefined);
    const files = [...event.dataTransfer.files];
    if (files.length) props.onUpload(files, folder);
  };
  const dragOver = (event: DragEvent<HTMLElement>, folder: string) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(folder);
  };
  // Opening a file keeps the tree where it was: the tab owns the scroll position, restored once
  // the rows are tall enough and saved when scrolling settles or the tab goes away.
  const initialScroll = useRef(props.scrollTop ?? 0);
  const onScrollRef = useRef(props.onScroll);
  useEffect(() => {
    onScrollRef.current = props.onScroll;
  });
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    return attachWorkspaceScroll(node, initialScroll.current, (position) =>
      onScrollRef.current?.(position),
    );
  }, []);

  let status: ReactNode = null;
  if (searching && !online)
    status = <Note>ace is offline. Search works again once it reconnects.</Note>;
  else if (searching && search.error)
    status = (
      <Note role="alert">
        Couldn't search the checkout. {search.error.message}{" "}
        <button
          type="button"
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={() => void search.refetch()}
        >
          Try again
        </button>
      </Note>
    );
  else if (searching && search.pending && !results?.length)
    status = (
      <Note>
        <Spinner /> Searching files…
      </Note>
    );
  else if (searching && results && !results.length)
    status = <Note>No files match “{query.trim()}”.</Note>;
  else if (!searching && !online)
    status = <Note>ace is offline. Files load again once it reconnects.</Note>;
  else if (!searching && !rows.length) status = <Note>This checkout is empty.</Note>;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(event) => dragOver(event, currentFolder ? `${currentFolder}/` : "")}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDropTarget(undefined);
      }}
      onDrop={(event) => drop(event, currentFolder ? `${currentFolder}/` : "")}
    >
      <FileTreeSearch
        query={query}
        onQuery={setQuery}
        pending={searching && search.pending}
        folder={currentFolder}
        disabled={!online}
        onOperation={props.onOperation}
        onUpload={props.onUpload}
        onFirstRow={() => focusRow(navigable[0]?.key)}
        onEnter={() => {
          const first = rows.find((row) => row.kind === "file");
          if (first) props.onOpen(first.key, true);
        }}
      />
      <div ref={attachScroll} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div
          ref={list}
          role="tree"
          aria-label={searching ? "Matching files" : "Checkout files"}
          data-part="file-tree"
          data-variant="files"
          aria-busy={searching && search.pending}
          className={cn(
            "flex flex-col rounded-md",
            dropTarget === "" && "shadow-[inset_0_0_0_1.5px_var(--ring)]",
          )}
        >
          <LongRows
            items={rows}
            virtualAbove={virtualAbove}
            handle={rowsHandle}
            rowKey={(row) => row.key}
            estimate={32}
            render={(row, index) => (
              <FileTreeRowView
                row={row}
                index={index}
                current={currentPath}
                focusable={row.key === focusable}
                searching={searching}
                query={query}
                online={online}
                dropTarget={dropTarget}
                onActivate={activate}
                onKeyDown={onRowKey}
                onFocus={setFocusKey}
                onOperation={props.onOperation}
                onDragOver={dragOver}
                onDrop={drop}
                onHoverStart={hoverStart}
                onHoverEnd={hoverEnd}
                onRetry={tree.retry}
                onMore={tree.showMore}
              />
            )}
          />
        </div>
        {status}
      </div>
      {props.footer}
    </div>
  );
}

function Note(props: { children: ReactNode; role?: "alert" }) {
  return (
    <p
      role={props.role}
      className="flex min-h-7 items-center gap-2 px-1 py-1 text-ui leading-snug text-muted-foreground"
    >
      {props.children}
    </p>
  );
}
