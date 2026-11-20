import { useClient } from "@ace/client-react";
import type { ExplorerState } from "@ace/ui-core/editor-workbench";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { ContentSearch } from "../files/content-search.tsx";
import {
  contentSearchStore,
  retainContentSearch,
  useContentSearch,
} from "../files/content-search-store.ts";
import type { FileOperationDialog } from "../files/file-operation.ts";
import { useEditor } from "../files/file-tree-editor.ts";
import { FileTree } from "../files/file-tree.tsx";
import type { RowMark } from "../files/file-tree-row.tsx";
import type { OpenHow } from "../files/tree-commands.ts";
import { useFileActions, type UploadState } from "../files/use-file-actions.ts";

const FileOperations = lazy(() =>
  import("../files/file-operations.tsx").then((module) => ({ default: module.FileOperations })),
);

const sides = [
  { value: "files", label: "Files" },
  { value: "search", label: "Search" },
] as const;

/** How a pick in the explorer opens a file, with the search match it came from. */
export interface ExplorerOpen {
  how: OpenHow;
  line?: number | undefined;
  column?: number | undefined;
  length?: number | undefined;
}

/**
 * The editor's explorer (spec 29, 32, 37): Open editors first, then Files or Search, one per thread,
 * its folders, filter, scroll and side kept with the layout. Search keeps its results beside the
 * editor after a pick. Uploads report under the tree.
 */
export function EditorExplorer(props: {
  threadId: string;
  explorer: ExplorerState;
  onExplorer(patch: Partial<ExplorerState>): void;
  /** The focused editor's file, which the tree follows. */
  current: string | undefined;
  onOpen(path: string, open: ExplorerOpen): void;
  openEditors: ReactNode;
  /** Bumped to put the keyboard in Search's field (⇧⌘F). */
  focusSearch: number;
  /** Rows an agent changed recently carry its mark, as their tabs do. */
  marks?: ReadonlyMap<string, RowMark> | undefined;
}) {
  const { threadId, explorer, onExplorer } = props;
  const client = useClient();
  const [operation, setOperation] = useState<FileOperationDialog>();
  const editor = useEditor(threadId);
  const open = (path: string, how: OpenHow = "keep") => props.onOpen(path, { how });
  const fileActions = useFileActions(threadId, (uploaded) => open(uploaded));
  useEffect(() => retainContentSearch(client, threadId), [client, threadId]);
  const searchStore = useMemo(() => contentSearchStore(client, threadId), [client, threadId]);
  const searchState = useContentSearch(searchStore);
  const searchInput = useRef<HTMLInputElement>(null);
  const [focusSearch, setFocusSearch] = useState(0);
  const focusRequest = props.focusSearch + focusSearch;
  useEffect(() => {
    if (!focusRequest) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [focusRequest]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {operation && (
        <Suspense fallback={null}>
          <FileOperations
            key={JSON.stringify(operation)}
            threadId={threadId}
            operation={operation}
            onClose={() => setOperation(undefined)}
            onChanged={(changed, destination) => {
              if (operation.kind === "create") open(changed);
              // A moved or renamed entry: its open editors (or those inside it) follow.
              if (destination) editor.renamed({ from: changed, to: destination, folder: true });
            }}
          />
        </Suspense>
      )}
      <WordChoice
        label="Files or search"
        value={explorer.side}
        options={sides}
        onValueChange={(side) => onExplorer({ side })}
        className="shrink-0 gap-0.5 px-2 pt-1.5 pb-1"
      />
      {explorer.side === "search" ? (
        <ContentSearch
          store={searchStore}
          state={searchState}
          ref={searchInput}
          onClose={() => onExplorer({ side: "files" })}
          onOpen={(path, line, column, keep, length) =>
            props.onOpen(path, { how: keep ? "keep" : "preview", line, column, length })
          }
        />
      ) : (
        <FileTree
          threadId={threadId}
          onOperation={setOperation}
          current={props.current}
          query={explorer.query}
          onQuery={(query) => onExplorer({ query })}
          expanded={explorer.expanded}
          onExpanded={(expanded) => onExplorer({ expanded })}
          scrollTop={explorer.scroll}
          onScroll={(scroll) => onExplorer({ scroll })}
          onOpen={open}
          onDownload={(target) => void fileActions.save(target)}
          onFindInFolder={(folder) => {
            searchStore.update({ include: folder ? `${folder}/**` : "" }, true);
            onExplorer({ side: "search" });
            setFocusSearch((value) => value + 1);
          }}
          onUpload={(files, folder) => void fileActions.uploadFiles(files, folder)}
          openEditors={props.openEditors}
          marks={props.marks}
          footer={
            fileActions.upload && (
              <UploadStatus
                state={fileActions.upload}
                onReplace={fileActions.replace}
                onDismiss={fileActions.dismissUpload}
              />
            )
          }
        />
      )}
    </div>
  );
}

/** The upload line under the tree: progress, a conflict to confirm, or what went wrong. */
function UploadStatus(props: { state: UploadState; onReplace(): void; onDismiss(): void }) {
  const { state } = props;
  return (
    <div
      role={state.phase === "failed" ? "alert" : "status"}
      className="flex shrink-0 flex-col gap-2 border-t px-3 py-2.5 text-xs leading-4"
    >
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {state.phase === "sending" && <Spinner />}
        <span className="min-w-0 flex-1">
          {state.phase === "sending" &&
            `Uploading ${state.name} · ${state.size ? Math.floor((state.sent / state.size) * 100) : 100}%`}
          {state.phase === "conflict" && `${state.path} already exists. Replace it?`}
          {state.phase === "failed" && `Couldn't upload ${state.name}. ${state.error.message}`}
        </span>
      </span>
      <span className="flex justify-end gap-1.5">
        {state.phase === "conflict" && (
          <Button size="sm" variant="secondary" onClick={props.onReplace}>
            Replace
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={props.onDismiss}>
          {state.phase === "sending" ? "Cancel" : "Dismiss"}
        </Button>
      </span>
    </div>
  );
}
