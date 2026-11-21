import { useClient, useConnectionState } from "@ace/client-react";
import {
  cleanPath,
  folderKey,
  openedFolders,
  pathParts,
  rankPathMatches,
  toggledFolders,
  type FolderRow,
} from "@ace/ui-core";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
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
import { FileMatches, matchId } from "./file-matches.tsx";
import type { FileOperationDialog } from "./file-operation.ts";
import { FileRowItems } from "./file-row-items.tsx";
import { isSecondClick } from "./second-click.ts";
import { FileTreeRowView, type RowMark } from "./file-tree-row.tsx";
import { FileTreeSearch } from "./file-tree-search.tsx";
import { ExplorerHeader, FileTreeActions } from "./explorer-header.tsx";
import { useCheckoutSearch, usePrefetchFile } from "./use-checkout.ts";
import { useExplorerFollows, useRevealRows, type RevealTarget } from "./file-tree-follow.ts";
import { useInlineRename } from "./file-tree-rename.tsx";
import { draftKey, rowsWithDraft, useInlineCreate } from "./file-tree-create.ts";
import { useFolderTree } from "./use-folder-tree.ts";
import { useLineCounts } from "./use-line-counts.ts";
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
  /**
   * The explorer's header row, where the tree's actions go (null until it mounts). Without one
   * the tree draws its own header.
   */
  actionsIn?: HTMLElement | null | undefined;
}) {
  const online = useConnectionState() === "ready";
  const { query, onQuery: setQuery } = props;
  const search = useCheckoutSearch(props.threadId, query);
  const searching = query.trim().length > 0;
  const results = searching ? search.data : undefined;
  // The filter's matches are one flat list, the best names first (never a tree of their folders).
  const matches = useMemo(() => rankPathMatches(query, results ?? []), [query, results]);
  const [activeMatch, setActiveMatch] = useState({ query, index: 0 });
  const matchIndex =
    activeMatch.query === query ? Math.min(activeMatch.index, Math.max(0, matches.length - 1)) : 0;
  const moveMatch = (delta: number) => {
    if (!matches.length) return;
    setActiveMatch({ query, index: (matchIndex + delta + matches.length) % matches.length });
  };
  const matchList = useId();
  // Folders start folded: a checkout holds far more than a screen. The tab keeps which folders
  // the person opened; unset, only the current file's parents stand open so it shows.
  const currentPath = props.current;
  const onExpanded = props.onExpanded;
  const [follows, setFollows] = useExplorerFollows();
  // Unset, the current file's folders stand open only while the explorer follows it.
  const opened = useMemo(
    () => openedFolders(props.expanded ?? (follows ? undefined : []), currentPath),
    [props.expanded, follows, currentPath],
  );
  const tree = useFolderTree({ threadId: props.threadId, expanded: opened, paused: searching });
  const lineCounts = useLineCounts(props.threadId);
  // New file and New folder are named in a field at the top of their folder.
  const revealLater = useRef<(target: RevealTarget) => void>(() => {});
  const create = useInlineCreate({
    threadId: props.threadId,
    opened,
    onExpanded,
    reveal: (target) => revealLater.current(target),
    onFile: (path) => props.onOpen(path, "keep"),
  });
  const rows = useMemo(
    () => (searching ? [] : rowsWithDraft(tree.rows, create.draft)),
    [searching, tree.rows, create.draft],
  );
  const [focusKey, setFocusKey] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const navigable = useMemo(
    () => rows.filter((row) => row.kind !== "loading" && row.kind !== "error"),
    [rows],
  );
  const focusable = navigable.some((row) => row.key === focusKey)
    ? focusKey
    : (navigable.find((row) => row.key === currentPath)?.key ?? navigable[0]?.key);

  const toggle = (key: string, expand?: boolean) => {
    // A compacted chain ("apps/web/src") folds and opens as its first folder.
    const folder = tree.rows.find((row) => row.key === key)?.chain?.[0] ?? key;
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
      toggle(row.key);
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
  useEffect(() => {
    revealLater.current = reveal;
  });
  // A new entry's field shows where it will land: scrolled to (and so mounted) once its folder
  // is listed, however far down a long tree that is.
  const draftAt = rows.findIndex((row) => row.key === draftKey);
  const shownDraft = useRef<unknown>(undefined);
  useEffect(() => {
    if (draftAt < 0 || shownDraft.current === create.draft) return;
    shownDraft.current = create.draft;
    const field = list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(draftKey)}"]`);
    if (field) field.scrollIntoView?.({ block: "nearest" });
    else rowsHandle.current?.scrollToIndex(draftAt, "auto");
  }, [draftAt, create.draft]);
  const rename = useInlineRename(props.threadId, reveal);
  /** A folder the filter found: the filter clears and the tree opens down to it. */
  const showFolder = (path: string) => {
    setQuery("");
    reveal({ path: cleanPath(path), folder: true, focus: true });
  };
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
    // Rename and New file or folder happen in the tree; every other operation is the tab's dialog.
    operation: (operation) => {
      if (operation.kind === "create" || operation.kind === "mkdir")
        return create.start(operation.kind === "create" ? "file" : "folder", operation.folder);
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
    focusFilter: () =>
      list.current?.parentElement?.parentElement
        ?.querySelector<HTMLInputElement>("input[type=search]")
        ?.focus(),
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

  const actions = (
    <FileTreeActions
      folder={currentFolder}
      disabled={!online}
      onOperation={commands.operation}
      onUpload={props.onUpload}
      onCollapseAll={() => commands.collapseBelow("")}
      follows={follows}
      onFollows={setFollows}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {props.actionsIn === undefined ? (
        <ExplorerHeader>{actions}</ExplorerHeader>
      ) : (
        props.actionsIn && createPortal(actions, props.actionsIn)
      )}
      {/* Outside the tree's drop area: a drop there isn't an upload into the checkout. */}
      {props.openEditors}
      <div className="flex min-h-0 flex-1 flex-col" {...drag.area}>
        <FileTreeSearch
          query={query}
          onQuery={setQuery}
          pending={searching && search.pending}
          onFirstRow={() => (searching ? moveMatch(1) : focusRow(navigable[0]?.key))}
          onPrevious={() => searching && moveMatch(-1)}
          matches={
            searching && matches.length
              ? { list: matchList, active: matchId(matchList, matchIndex) }
              : undefined
          }
          onEnter={() => {
            const picked = matches[matchIndex];
            if (!searching || !picked) return;
            if (picked.endsWith("/")) showFolder(picked);
            else props.onOpen(picked, "keep");
          }}
        />
        <div
          ref={attachScroll}
          className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-1.5 pb-2"
        >
          {searching && (
            <FileMatches
              id={matchList}
              query={query}
              paths={matches}
              active={matchIndex}
              current={currentPath}
              onActive={(index) => setActiveMatch({ query, index })}
              onOpen={props.onOpen}
              onFolder={showFolder}
              commands={commands}
            />
          )}
          <div
            ref={list}
            role="tree"
            hidden={searching}
            aria-label="Checkout files"
            data-part="file-tree"
            data-variant="files"
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
              estimate={28}
              render={(row, index) => (
                <FileTreeRowView
                  row={row}
                  index={index}
                  current={currentPath}
                  focusable={row.key === focusable}
                  online={online}
                  dropTarget={drag.dropTarget}
                  drag={drag}
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
                  renaming={
                    row.key === draftKey
                      ? create.field
                      : rename.key === row.key
                        ? rename
                        : undefined
                  }
                  mark={props.marks?.get(row.key)}
                  counts={lineCounts.get(row.key)}
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
            empty={!searching && !rows.length}
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
