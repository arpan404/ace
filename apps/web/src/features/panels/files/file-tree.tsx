import { useClient, useConnectionState } from "@ace/client-react";
import {
  buildFileTree,
  checkoutTreeRows,
  cleanPath,
  folderKey,
  openedFolders,
  pathParts,
  toggledFolders,
  type FolderRow,
} from "@ace/ui-core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { MenuCheckboxItem, MenuSeparator } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { keyboardEnv } from "@/lib/keybindings.ts";
import { attachWorkspaceScroll } from "@/lib/workspace/index.ts";
import type { FileOperationDialog } from "./file-operation.ts";
import { FileRowItems } from "./file-row-items.tsx";
import { isSecondClick } from "./second-click.ts";
import { FileTreeRowView, type RowMark } from "./file-tree-row.tsx";
import { FileTreeSearch } from "./file-tree-search.tsx";
import { useCheckoutSearch, usePrefetchFile } from "./use-checkout.ts";
import { useExplorerFollows, useRevealRows } from "./file-tree-follow.ts";
import { useInlineRename } from "./file-tree-rename.tsx";
import { useFolderTree } from "./use-folder-tree.ts";
import { useTreeCommands, type OpenHow, type TreeCommands } from "./tree-commands.ts";
import { entryOf, onRowKey as onKeyFor, type RowKeyContext } from "./tree-row-keys.ts";
import { useTreeDrag } from "./use-tree-drag.ts";
import { useTreeSelection } from "./use-tree-selection.ts";
import { siblingPositions, type TypeAhead } from "./tree-navigation.ts";
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
  /**
   * The explorer's first section, above the filter: the editor's Open editors (workbench spec 29),
   * which draws and folds itself.
   */
  openEditors?: ReactNode;
  /** Files an agent changed recently, by path: their rows carry the agent's mark. */
  marks?: ReadonlyMap<string, RowMark> | undefined;
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
  const [follows, setFollows] = useExplorerFollows();
  // Unset, the current file's folders stand open only while the explorer follows it.
  const opened = useMemo(
    () => openedFolders(props.expanded ?? (follows ? undefined : []), currentPath),
    [props.expanded, follows, currentPath],
  );
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
  const toast = useToast();
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
  // A file opened from elsewhere (quick open, a tab) is revealed by opening its ancestors, each
  // of which lists on the way, then scrolled to and selected. Folding one by hand stays folded
  // until another file is revealed.
  const reveal = useRevealRows({
    threadId: props.threadId,
    current: currentPath,
    follows,
    opened,
    onExpanded,
    rows,
    list,
    handle: rowsHandle,
    onRevealed: (key, focus) => {
      if (focus) focusRow(key);
      else setFocusKey(key);
      if (key !== currentPath) selection.only(key);
    },
  });
  const rename = useInlineRename(props.threadId, reveal);
  const order = useMemo(
    () => navigable.filter((row) => row.kind !== "more").map((row) => row.key),
    [navigable],
  );
  const selection = useTreeSelection(order, currentPath);
  /**
   * A plain click picks one row and opens it; Ctrl/⌘ toggles it and Shift extends, no more.
   * Alt/Option opens a file to the side.
   */
  const pick = (row: FolderRow, event: MouseEvent<HTMLElement>) => {
    if (row.kind === "more") return activate(row, "preview");
    if (event.altKey && row.kind === "file") return activate(row, "side");
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
    // Rename happens in the row; every other operation is the tab's dialog.
    operation: (operation) => {
      if (operation.kind !== "rename") return props.onOperation(operation);
      const path = cleanPath(operation.path);
      rename.start(path, operation.path.endsWith("/") || byKey.has(folderKey(path)));
    },
    findInFolder: props.onFindInFolder,
    download: props.onDownload,
    opened,
    onExpanded,
    onMade: (key) => focusRow(key),
  });
  const typed = useRef<TypeAhead>({ text: "", at: 0 });
  const positions = useMemo(() => siblingPositions(rows), [rows]);
  const clip = commands.clip;
  const cutKeys = useMemo(
    () =>
      new Set(
        clip?.mode === "cut"
          ? clip.entries.map((entry) => (entry.folder ? folderKey(entry.path) : entry.path))
          : [],
      ),
    [clip],
  );
  const keys: RowKeyContext = {
    typed,
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
  const drag = useTreeDrag({
    threadId: props.threadId,
    onForeign: () =>
      toast.error({
        title: "Files can't be dragged between checkouts",
        description: "Each thread has its own checkout. Nothing was moved.",
      }),
    covered: commands.covered,
    onMove: commands.move,
    onUpload: props.onUpload,
    expand: (folder) => toggle(folder, true),
    uploadFolder: currentFolder ? `${currentFolder}/` : "",
  });
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Outside the tree's drop area: a drop there isn't an upload into the checkout. */}
      {props.openEditors}
      <div className="flex min-h-0 flex-1 flex-col" {...drag.area}>
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
              drag.dropTarget === "" && "shadow-[inset_0_0_0_1.5px_var(--ring)]",
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
                  dropTarget={drag.dropTarget}
                  drag={searching ? undefined : drag}
                  selected={selection.has(row.key)}
                  cut={cutKeys.has(row.key)}
                  place={positions.get(row.key)}
                  onPick={pick}
                  onActivate={activate}
                  onKeyDown={onRowKey}
                  onFocus={setFocusKey}
                  onRefocus={focusRow}
                  commands={commands}
                  onHoverStart={hoverStart}
                  onHoverEnd={hoverEnd}
                  onRetry={tree.retry}
                  onMore={tree.showMore}
                  renaming={!searching && rename.key === row.key ? rename : undefined}
                  mark={props.marks?.get(row.key)}
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
          <RootMenu commands={commands} follows={follows} onFollows={setFollows} />
        </div>
        {props.footer}
      </div>
    </div>
  );
}

/** The tree's empty space below its rows: right-click there acts on the checkout's root. */
function RootMenu(props: {
  commands: TreeCommands;
  follows: boolean;
  onFollows(follows: boolean): void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div data-part="tree-root" className="min-h-8 flex-1" aria-hidden />}
      />
      <ContextMenuContent>
        <FileRowItems entry={{ path: "", folder: true }} commands={props.commands} />
        <MenuSeparator />
        <MenuCheckboxItem checked={props.follows} onCheckedChange={props.onFollows}>
          Follow the open file
        </MenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
