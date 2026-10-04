import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react";
import { useConnectionState, useThreadMeta } from "@ace/client-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ResizeHandle } from "@/components/ui/resize-handle.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { useScrollEdges } from "@/lib/edge-fade.ts";
import { useElementSize } from "@/lib/element-size.ts";
import { matchesChord, parseChord } from "@/lib/hotkeys.ts";
import {
  useScopeWorkspace,
  useWorkspaceActions,
  type TabViewProps,
} from "@/lib/workspace/index.ts";
import { FileToolbar } from "./file-toolbar.tsx";
import { FileTree } from "./file-tree.tsx";
import { FileViewer, NoFile } from "./file-viewer.tsx";
import {
  fileTabData,
  treeLayout,
  useFilePrefs,
  useFilesMemory,
  useRecentFiles,
  useRecentFilesStore,
} from "./files-state.ts";
import { openFile } from "./open-file.ts";
import { quickOpen } from "./quick-open-store.ts";
import { findHits } from "./source-view.tsx";
import { useEditedPaths, useFileContent } from "./use-checkout.ts";
import { useFileActions, type UploadState } from "./use-file-actions.ts";

const findChord = parseChord("mod+f");
const fadeRight = { background: "linear-gradient(to left, var(--background), transparent)" };

/** Find in file: the text, how many places it occurs, and stepping between them. */
function FindBar(props: {
  query: string;
  count: number;
  index: number;
  onQuery(query: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div
      role="search"
      className="absolute top-2 right-3 z-10 flex h-9 items-center gap-1 rounded-lg border bg-popover pr-1 pl-2.5 shadow-[var(--glass-shadow)]"
    >
      <input
        ref={input}
        aria-label="Find in file"
        placeholder="Find"
        value={props.query}
        spellCheck={false}
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }
        }}
        className="h-full w-40 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground"
      />
      <span
        aria-live="polite"
        className="min-w-[64px] text-right text-xs text-subtle-foreground tabular-nums"
      >
        {props.query ? (props.count ? `${props.index + 1} of ${props.count}` : "No results") : ""}
      </span>
      <IconButton
        icon={CaretUpIcon}
        label="Previous match"
        keys="shift+enter"
        size="sm"
        className="size-7"
        disabled={!props.count}
        onClick={() => props.onStep(-1)}
      />
      <IconButton
        icon={CaretDownIcon}
        label="Next match"
        keys="enter"
        size="sm"
        className="size-7"
        disabled={!props.count}
        onClick={() => props.onStep(1)}
      />
      <IconButton
        icon={XIcon}
        label="Close find"
        keys="escape"
        size="sm"
        className="size-7"
        onClick={props.onClose}
      />
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

/**
 * A file of the thread's checkout: path breadcrumb and actions above, the source (or rendered
 * markdown, an image, or why it can't be shown) on the left and the checkout tree on the right.
 * The empty tab ("Open file") is the same view before a file is picked.
 */
export function FileTab(props: TabViewProps) {
  const threadId = props.scope;
  const data = fileTabData(props.tab);
  const path = data.path;
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const meta = useThreadMeta(threadId);
  const online = useConnectionState() === "ready";
  const memory = useFilesMemory();
  const [prefs] = useFilePrefs();
  const recent = useRecentFiles(threadId);
  const edited = useEditedPaths(threadId);
  const known = [...new Set([...(path ? [path] : []), ...recent, ...edited])];
  const content = useFileContent(threadId, path);
  const [query, setQuery] = useState("");
  const [find, setFind] = useState<{ query: string; index: number } | undefined>();
  // The tree goes beside the file while the source keeps 420px, else it steps aside (over the
  // file when asked for, closing once a file is picked). An empty tab always shows it.
  const root = useRef<HTMLDivElement>(null);
  const width = useElementSize(root).width;
  const treeWidth = prefs.treeWidth;
  const layout = treeLayout(width, treeWidth, { file: !!path, chosen: data.tree });
  const treeShown = layout !== "hidden";
  const over = layout === "over";
  const viewer = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(viewer);
  const open = (target: string, keep: boolean) =>
    openFile(workspace, actions, target, {
      keep,
      from: props.tab.key,
      tree: over ? undefined : data.tree,
    });
  const fileActions = useFileActions(threadId, (uploaded) => open(uploaded, true));

  const recentStore = useRecentFilesStore();
  useEffect(() => {
    if (path) recentStore.remember(threadId, path);
  }, [recentStore, threadId, path]);

  const text = content.data?.kind === "text" ? content.data.text : undefined;
  const readable = text !== undefined && !(path?.match(/\.(md|markdown|mdx)$/i) && !data.source);
  const hits = useMemo(
    () => (find && text !== undefined ? findHits(text, find.query) : []),
    [find, text],
  );
  const hitIndex =
    find && hits.length ? ((find.index % hits.length) + hits.length) % hits.length : 0;
  const toggleFind = () => setFind((current) => (current ? undefined : { query: "", index: 0 }));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readable && matchesChord(event.nativeEvent, findChord)) {
      event.preventDefault();
      setFind((current) => current ?? { query: "", index: 0 });
    }
  };
  const update = (patch: Partial<typeof data>) =>
    actions.update(props.tab.key, { data: { ...data, ...patch } });

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <FileToolbar
        project={meta?.workspaceId ?? "Checkout"}
        path={path}
        preview={data.preview === true}
        source={data.source === true}
        wrap={prefs.wrap}
        finding={find !== undefined}
        treeOpen={treeShown}
        readable={readable}
        online={online}
        actions={fileActions}
        line={find?.query && hits[hitIndex] ? (hits[hitIndex]?.line ?? 0) + 1 : data.line}
        onFolder={(folder) => {
          setQuery(folder);
          if (!treeShown) update({ tree: true });
        }}
        onKeep={() => update({ preview: false })}
        onSource={(source) => update({ source })}
        onWrap={() => memory.setPrefs({ wrap: !prefs.wrap })}
        onFind={toggleFind}
        onTree={() => update({ tree: !treeShown })}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {find && (
            <FindBar
              query={find.query}
              count={hits.length}
              index={hitIndex}
              onQuery={(next) => setFind({ query: next, index: 0 })}
              onStep={(delta) => setFind({ query: find.query, index: hitIndex + delta })}
              onClose={() => setFind(undefined)}
            />
          )}
          <div ref={viewer} className="h-full overflow-auto" tabIndex={-1}>
            {path ? (
              <FileViewer
                path={path}
                content={content.data}
                error={content.error}
                wrap={prefs.wrap}
                source={data.source === true}
                find={find?.query ? { query: find.query, hit: hits[hitIndex] } : undefined}
                line={data.line}
                onRetry={() => void content.refetch()}
                onDownload={() => void fileActions.save(path)}
                onFind={() => quickOpen.set(() => threadId)}
              />
            ) : (
              <NoFile onSearch={() => quickOpen.set(() => threadId)} />
            )}
          </div>
          {/* Lines run on past the right edge: a fade says so (wrap lines to see them whole). */}
          {edges.end && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-6"
              style={fadeRight}
            />
          )}
        </div>
        {treeShown && (
          <aside
            role="complementary"
            data-edge="right"
            aria-label="Checkout files"
            style={{ width: over ? Math.min(treeWidth, 320) : treeWidth }}
            className={cn(
              "relative flex min-h-0 shrink-0 flex-col border-l bg-background",
              over &&
                "fx-panel-in absolute inset-y-0 right-0 z-[3] max-w-[85%] shadow-[-12px_0_32px_rgb(0_0_0/0.22)]",
            )}
            onKeyDown={(event) => {
              if (over && event.key === "Escape") update({ tree: false });
            }}
          >
            {!over && (
              <ResizeHandle
                label="Resize the file tree"
                edge="left"
                size={treeWidth}
                min={200}
                max={360}
                onResize={(next) => memory.setPrefs({ treeWidth: next }, false)}
                onResizeEnd={(next) => memory.setPrefs({ treeWidth: next })}
              />
            )}
            <FileTree
              threadId={threadId}
              known={known}
              current={path}
              query={query}
              onQuery={setQuery}
              onOpen={open}
              onUpload={(files, folder) => void fileActions.uploadFiles(files, folder)}
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
          </aside>
        )}
      </div>
    </div>
  );
}

export default FileTab;
