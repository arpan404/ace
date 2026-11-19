import { useClient, useConnectionState } from "@ace/client-react";
import {
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
  type MouseEvent,
  type ReactNode,
} from "react";
import { LongRows, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { cn } from "@/lib/cn.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import { attachWorkspaceScroll } from "@/lib/workspace/index.ts";
import type { FileOperationDialog } from "./file-operation.ts";
import { FileRowItems } from "./file-row-items.tsx";
import { isSecondClick } from "./second-click.ts";
import { FileTreeRowView } from "./file-tree-row.tsx";
import { FileTreeSearch } from "./file-tree-search.tsx";
import { useCheckoutSearch, usePrefetchFile } from "./use-checkout.ts";
import { useFolderTree } from "./use-folder-tree.ts";
import { useTreeCommands, type OpenHow, type TreeCommands } from "./tree-commands.ts";
import { entryOf, onRowKey as onKeyFor, type RowKeyContext } from "./tree-row-keys.ts";
import { useTreeSelection } from "./use-tree-selection.ts";
import { TreeStatus } from "./tree-status.tsx";

/** Past this many rows, only those near the viewport mount: each row carries two menus. */
const virtualAbove = 200;
/** How long the pointer rests on a file before it's read ahead: passing over rows reads nothing. */
const prefetchDelay = 80;

/** The file tree of a thread's checkout: a folder is listed when it opens, a page at a time. */
export function FileTree(props: {
  threadId: string;
  onOperation(operation: FileOperationDialog): void;
  current: string | undefined;
  onOpen(path: string, how: OpenHow): void;
  onUpload(files: readonly File[], folder: string): void;
  /** Search file contents with `folder` ("" is the root) as the files to include. */
  onFindInFolder(folder: string): void;
  onDownload(path: string): void;
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
  const client = useClient();
  const activate = (row: FolderRow, how: OpenHow, at?: number) => {
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
    if (row.kind !== "file") return;
    const second =
      how === "preview" && at !== undefined && isSecondClick(client, props.threadId, row.key, at);
    props.onOpen(row.key, second ? "keep" : how);
  };
  const order = useMemo(
    () => navigable.filter((row) => row.kind !== "more").map((row) => row.key),
    [navigable],
  );
  const selection = useTreeSelection(order, currentPath);
  /** A plain click picks one row and opens it; Ctrl/⌘ toggles it and Shift extends, no more. */
  const pick = (row: FolderRow, event: MouseEvent<HTMLElement>) => {
    if (row.kind === "more") return activate(row, "preview");
    if (event.shiftKey) return selection.extend(row.key);
    if (keyboardEnv().apple ? event.metaKey : event.ctrlKey) return selection.toggle(row.key);
    selection.only(row.key);
    activate(row, "preview", event.timeStamp);
  };
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const commands = useTreeCommands({
    threadId: props.threadId,
    online,
    covered: (entry) => {
      const key = entry.folder ? folderKey(entry.path) : entry.path;
      if (!selection.has(key) || selection.keys.size < 2) return [entry];
      return [...selection.keys].flatMap((each) => {
        const listedRow = byKey.get(each);
        return listedRow ? [entryOf(listedRow)] : [];
      });
    },
    open: props.onOpen,
    operation: props.onOperation,
    findInFolder: props.onFindInFolder,
    download: props.onDownload,
    opened,
    onExpanded,
    onMade: (key) => focusRow(key),
  });
  const keys: RowKeyContext = {
    rows,
    commands,
    selection,
    focusRow,
    focusFilter: () => list.current?.parentElement?.parentElement?.querySelector("input")?.focus(),
    toggle,
    activate,
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, row: FolderRow, index: number) =>
    onKeyFor(keys, event, row, index);
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
          if (first) props.onOpen(first.key, "keep");
        }}
      />
      <div ref={attachScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <div
          ref={list}
          role="tree"
          aria-label={searching ? "Matching files" : "Checkout files"}
          data-part="file-tree"
          data-variant="files"
          aria-busy={searching && search.pending}
          aria-multiselectable
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
                selected={selection.has(row.key)}
                onPick={pick}
                onActivate={activate}
                onKeyDown={onRowKey}
                onFocus={setFocusKey}
                commands={commands}
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
        <TreeStatus
          online={online}
          searching={searching}
          query={query}
          search={search}
          results={results}
          empty={!rows.length}
        />
        <RootMenu commands={commands} />
      </div>
      {props.footer}
    </div>
  );
}

/** The tree's empty space below its rows: right-click there acts on the checkout's root. */
function RootMenu(props: { commands: TreeCommands }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div data-part="tree-root" className="min-h-8 flex-1" aria-hidden />}
      />
      <ContextMenuContent>
        <FileRowItems entry={{ path: "", folder: true }} commands={props.commands} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
