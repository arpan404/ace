import {
  CaretRightIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import {
  ancestorFolders,
  buildFileTree,
  fuzzyPositions,
  pathParts,
  checkoutTreeRows,
  type FileTreeRow,
} from "@ace/ui-core";
import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { fileIcon } from "./file-icon.ts";
import { useCheckoutSearch } from "./use-checkout.ts";

const rowClass =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-ui text-muted-foreground outline-none select-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)] aria-selected:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] aria-selected:text-foreground";

/** "config.ts" with the characters a fuzzy query matched in full ink. */
function Highlighted(props: { text: string; offset: number; positions: readonly number[] }) {
  if (!props.positions.length) return props.text;
  const hits = new Set(props.positions.map((position) => position - props.offset));
  const parts: ReactNode[] = [];
  let run = "";
  let lit = false;
  const flush = (index: number) => {
    if (!run) return;
    parts.push(
      lit ? (
        <b key={index} className="font-medium text-foreground">
          {run}
        </b>
      ) : (
        run
      ),
    );
    run = "";
  };
  for (let index = 0; index < props.text.length; index++) {
    const hit = hits.has(index);
    if (hit !== lit) {
      flush(index);
      lit = hit;
    }
    run += props.text[index];
  }
  flush(props.text.length);
  return parts;
}

/**
 * The checkout tree beside a file: a filter that searches the whole checkout (the daemon's path
 * index) and, without one, the files this thread touched. There is no folder listing on the wire
 * yet, so the unfiltered tree says so instead of passing a partial tree off as the checkout.
 */
export function FileTree(props: {
  threadId: string;
  /** Files this thread edited or opened, newest first. */
  known: readonly string[];
  current: string | undefined;
  onOpen(path: string, keep: boolean): void;
  onUpload(files: readonly File[], folder: string): void;
  /** The filter's text, owned by the tab so its breadcrumb can narrow it to a folder. */
  query: string;
  onQuery(query: string): void;
  /** Shown under the tree: an upload in progress or what stopped it. */
  footer?: ReactNode;
}) {
  const online = useConnectionState() === "ready";
  const { query, onQuery: setQuery } = props;
  const search = useCheckoutSearch(props.threadId, query);
  const searching = query.trim().length > 0;
  const results = searching ? search.data : undefined;
  const tree = useMemo(
    () => buildFileTree(searching ? (results ?? []) : props.known),
    [searching, results, props.known],
  );
  // Folders start open: the known tree is small and search results are worth seeing whole.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () => checkoutTreeRows(tree, (folder) => !collapsed.has(folder)),
    [tree, collapsed],
  );
  const [focusKey, setFocusKey] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const focusable = rows.some((row) => row.node.path === focusKey)
    ? focusKey
    : (rows.find((row) => row.node.path === props.current)?.node.path ?? rows[0]?.node.path);

  const toggle = (folder: string, open?: boolean) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      const shouldOpen = open ?? next.has(folder);
      if (shouldOpen) next.delete(folder);
      else next.add(folder);
      return next;
    });
  const focusRow = (path: string | undefined) => {
    if (!path) return;
    setFocusKey(path);
    list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus();
  };
  const activate = (row: FileTreeRow, keep: boolean) => {
    if (row.node.kind === "folder") {
      // A folder found by search narrows the search to it; one in the tree opens or closes.
      if (searching) setQuery(row.node.path);
      else toggle(row.node.path);
      return;
    }
    props.onOpen(row.node.path, keep);
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, row: FileTreeRow, index: number) => {
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]?.node.path);
        break;
      case "ArrowUp":
        if (index === 0) list.current?.parentElement?.querySelector("input")?.focus();
        else focusRow(rows[index - 1]?.node.path);
        break;
      case "Home":
        focusRow(rows[0]?.node.path);
        break;
      case "End":
        focusRow(rows.at(-1)?.node.path);
        break;
      case "ArrowRight":
        if (row.node.kind !== "folder") return;
        if (!row.expanded) toggle(row.node.path, true);
        else focusRow(rows[index + 1]?.node.path);
        break;
      case "ArrowLeft":
        if (row.node.kind === "folder" && row.expanded) toggle(row.node.path, false);
        else focusRow(ancestorFolders(row.node.path).at(-1));
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
  const currentFolder = props.current ? pathParts(props.current).folder : "";
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
  const upload = useRef<HTMLInputElement>(null);

  let status: ReactNode = null;
  if (searching && !online)
    status = <Note>The daemon is offline. Search works again once it reconnects.</Note>;
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
  else if (!searching && !rows.length)
    status = <Note>Nothing opened yet. Type above to find any file in the checkout.</Note>;

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
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <label className="relative flex h-8 min-w-0 flex-1 items-center rounded-md bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] shadow-[inset_0_0_0_1px_var(--border)] transition-shadow duration-(--dur-1) focus-within:shadow-[inset_0_0_0_1px_var(--ring)]">
          <MagnifyingGlassIcon
            aria-hidden
            size={14}
            className="ml-2.5 shrink-0 text-subtle-foreground"
          />
          <input
            type="search"
            aria-label="Find files in the checkout"
            placeholder="Find files…"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(rows[0]?.node.path);
              } else if (event.key === "Enter") {
                const first = rows.find((row) => row.node.kind === "file");
                if (first) props.onOpen(first.node.path, true);
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent pr-1 pl-2 text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {searching && search.pending && <Spinner className="mr-1.5" />}
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
            >
              <XIcon aria-hidden size={12} />
            </button>
          )}
        </label>
        <IconButton
          icon={UploadSimpleIcon}
          label={currentFolder ? `Upload to ${currentFolder}` : "Upload to the checkout"}
          className="size-8"
          disabled={!online}
          onClick={() => upload.current?.click()}
        />
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) props.onUpload(files, currentFolder ? `${currentFolder}/` : "");
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!searching && rows.length > 0 && (
          <p className="flex h-6 items-center px-1 text-xs text-subtle-foreground">This thread</p>
        )}
        <div
          ref={list}
          role="tree"
          aria-label={searching ? "Matching files" : "Files this thread touched"}
          aria-busy={searching && search.pending}
          className={cn(
            "flex flex-col rounded-md",
            dropTarget === "" && "shadow-[inset_0_0_0_1.5px_var(--ring)]",
          )}
        >
          {rows.map((row, index) => {
            const folder = row.node.kind === "folder";
            const positions = searching
              ? (fuzzyPositions(query.trim(), row.node.path.replace(/\/$/, "")) ?? [])
              : [];
            const nameStart = row.node.path.replace(/\/$/, "").length - row.node.name.length;
            return (
              <button
                key={row.node.path}
                type="button"
                role="treeitem"
                data-path={row.node.path}
                aria-level={row.depth + 1}
                aria-expanded={folder ? row.expanded : undefined}
                aria-selected={row.node.path === props.current}
                tabIndex={row.node.path === focusable ? 0 : -1}
                title={row.node.path}
                onFocus={() => setFocusKey(row.node.path)}
                onClick={() => activate(row, false)}
                onDoubleClick={() => !folder && props.onOpen(row.node.path, true)}
                onKeyDown={(event) => onRowKey(event, row, index)}
                onDragOver={folder ? (event) => dragOver(event, row.node.path) : undefined}
                onDrop={folder ? (event) => drop(event, row.node.path) : undefined}
                style={{ paddingLeft: 4 + row.depth * 12 }}
                className={cn(
                  rowClass,
                  folder &&
                    dropTarget === row.node.path &&
                    "shadow-[inset_0_0_0_1.5px_var(--ring)]",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {folder && (
                    <CaretRightIcon
                      aria-hidden
                      size={10}
                      weight="bold"
                      className={cn(
                        "text-subtle-foreground transition-transform duration-(--dur-1)",
                        row.expanded && "rotate-90",
                      )}
                    />
                  )}
                </span>
                <Icon
                  icon={
                    folder ? (row.expanded ? FolderOpenIcon : FolderIcon) : fileIcon(row.node.path)
                  }
                  size={14}
                  className="text-subtle-foreground"
                />
                <span className="min-w-0 truncate">
                  <Highlighted text={row.node.name} offset={nameStart} positions={positions} />
                </span>
              </button>
            );
          })}
        </div>
        {status}
      </div>
      {props.footer}
      {!searching && !props.footer && (
        <p className="flex shrink-0 items-start gap-1.5 border-t px-3 py-2 text-xs leading-4 text-subtle-foreground">
          <InfoIcon aria-hidden size={12} className="mt-0.5 shrink-0" />
          <span>
            Showing files this thread touched. The daemon can't list folders yet; find any other
            file by name above.
          </span>
        </p>
      )}
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
