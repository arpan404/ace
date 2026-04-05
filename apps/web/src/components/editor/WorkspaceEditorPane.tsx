import Editor, { type OnMount } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { FolderIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThreadEditorPaneState } from "~/editorStateStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "~/vscode-icons";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface WorkspaceEditorPaneProps {
  active: boolean;
  canClosePane: boolean;
  canSplitPane: boolean;
  dirtyFilePaths: ReadonlySet<string>;
  draftsByFilePath: Record<string, { draftContents: string; savedContents: string }>;
  gitCwd: string | null;
  onCloseFile: (paneId: string, filePath: string) => void;
  onClosePane: (paneId: string) => void;
  onDiscardDraft: (filePath: string) => void;
  onFocusPane: (paneId: string) => void;
  onHydrateFile: (filePath: string, contents: string) => void;
  onSaveFile: (relativePath: string, contents: string) => void;
  onSetActiveFile: (paneId: string, filePath: string | null) => void;
  onSplitPane: (paneId: string) => void;
  onUpdateDraft: (filePath: string, contents: string) => void;
  pane: ThreadEditorPaneState;
  paneIndex: number;
  resolvedTheme: "light" | "dark";
  savingFilePath: string | null;
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 KB";
  }
  if (sizeBytes < 1024) {
    return "<1 KB";
  }
  return `${Math.round(sizeBytes / 1024)} KB`;
}

function FilePathBreadcrumbs(props: { pathValue: string }) {
  const segments = useMemo(() => {
    let currentPath = "";
    return props.pathValue.split("/").map((segment) => {
      currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment;
      return { key: currentPath, segment };
    });
  }, [props.pathValue]);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/80">
      {segments.map(({ key, segment }, index) => (
        <div key={key} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span className="text-muted-foreground/45">/</span> : null}
          <span className="rounded-sm bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
            {segment}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
  const pane = props.pane;
  const onFocusPane = props.onFocusPane;
  const onHydrateFile = props.onHydrateFile;
  const onSaveFile = props.onSaveFile;
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.gitCwd,
      relativePath: pane.activeFilePath,
      enabled: pane.activeFilePath !== null && props.gitCwd !== null,
    }),
  );

  useEffect(() => {
    if (!pane.activeFilePath || activeFileQuery.data?.contents === undefined) {
      return;
    }
    onHydrateFile(pane.activeFilePath, activeFileQuery.data.contents);
  }, [activeFileQuery.data?.contents, onHydrateFile, pane.activeFilePath]);

  const activeDraft = pane.activeFilePath
    ? (props.draftsByFilePath[pane.activeFilePath] ?? null)
    : null;
  const activeFileContents = activeDraft?.draftContents ?? activeFileQuery.data?.contents ?? "";
  const activeFileDirty = activeDraft
    ? activeDraft.draftContents !== activeDraft.savedContents
    : false;
  const activeFileSizeBytes =
    activeFileQuery.data?.sizeBytes ?? new Blob([activeFileContents]).size;
  const dirtyTabCount = pane.openFilePaths.filter((path) => props.dirtyFilePaths.has(path)).length;

  const handleSave = useCallback(() => {
    if (!pane.activeFilePath || !activeDraft) {
      return;
    }
    onSaveFile(pane.activeFilePath, activeDraft.draftContents);
  }, [activeDraft, onSaveFile, pane.activeFilePath]);

  const saveActionRef = useRef(handleSave);
  useEffect(() => {
    saveActionRef.current = handleSave;
  }, [handleSave]);

  const handleEditorMount = useCallback<OnMount>(
    (editor, monacoInstance) => {
      editor.onDidFocusEditorWidget(() => {
        onFocusPane(pane.id);
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        saveActionRef.current();
      });
    },
    [onFocusPane, pane.id],
  );

  return (
    <section
      data-pane-active={props.active ? "true" : "false"}
      className={cn(
        "group flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border shadow-[0_22px_60px_rgba(0,0,0,0.14)] transition-colors",
        props.resolvedTheme === "dark"
          ? props.active
            ? "border-primary/35 bg-[#0e131a]/96"
            : "border-border/55 bg-[#0b1016]/92"
          : props.active
            ? "border-primary/28 bg-[#fffdf8]"
            : "border-border/70 bg-[#f7f1e7]/92",
      )}
      onPointerDown={() => {
        props.onFocusPane(props.pane.id);
      }}
    >
      <header
        className={cn(
          "border-b px-4 py-3",
          props.resolvedTheme === "dark"
            ? "border-border/55 bg-[#111720]/86"
            : "border-border/70 bg-[#f4ebde]/82",
        )}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={props.active ? "default" : "outline"}
                size="sm"
                className="rounded-full px-2"
              >
                Window {props.paneIndex + 1}
              </Badge>
              {props.active ? (
                <Badge variant="info" size="sm" className="rounded-full px-2">
                  Focused
                </Badge>
              ) : null}
              {dirtyTabCount > 0 ? (
                <Badge variant="warning" size="sm" className="rounded-full px-2">
                  {dirtyTabCount} unsaved
                </Badge>
              ) : null}
            </div>
            <div className="mt-2 min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {props.pane.activeFilePath
                  ? basenameOfPath(props.pane.activeFilePath)
                  : `Window ${props.paneIndex + 1}`}
              </p>
              {props.pane.activeFilePath ? (
                <div className="mt-1 min-w-0">
                  <FilePathBreadcrumbs pathValue={props.pane.activeFilePath} />
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  Choose a file from Explorer to start editing here.
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              className="rounded-full"
              onClick={() => props.onSplitPane(props.pane.id)}
              disabled={!props.canSplitPane}
            >
              Split
            </Button>
            {props.canClosePane ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                onClick={() => props.onClosePane(props.pane.id)}
                aria-label={`Close window ${props.paneIndex + 1}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div
        className={cn(
          "border-b px-3 pt-2",
          props.resolvedTheme === "dark"
            ? "border-border/50 bg-[#0c1118]"
            : "border-border/60 bg-[#fbf7ef]",
        )}
      >
        <div className="scrollbar-thin flex min-h-11 items-end gap-2 overflow-x-auto pb-2">
          {props.pane.openFilePaths.map((filePath) => {
            const isActive = filePath === props.pane.activeFilePath;
            const isDirty = props.dirtyFilePaths.has(filePath);
            return (
              <button
                key={filePath}
                type="button"
                className={cn(
                  "group flex h-9 items-center gap-2 rounded-t-xl border border-b-0 px-3 text-sm transition-colors",
                  isActive
                    ? props.resolvedTheme === "dark"
                      ? "border-border/70 bg-[#141a22] text-foreground"
                      : "border-border/70 bg-white text-foreground"
                    : "border-transparent bg-transparent text-muted-foreground hover:border-border/50 hover:bg-foreground/4 hover:text-foreground",
                )}
                onClick={() => props.onSetActiveFile(props.pane.id, filePath)}
                title={filePath}
              >
                <VscodeEntryIcon
                  pathValue={filePath}
                  kind="file"
                  theme={props.resolvedTheme}
                  className="size-4"
                />
                <span className="max-w-44 truncate">{basenameOfPath(filePath)}</span>
                {isDirty ? <span className="size-1.5 rounded-full bg-amber-500" /> : null}
                <span
                  className="rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onCloseFile(props.pane.id, filePath);
                  }}
                >
                  <XIcon className="size-3.5" />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 min-w-0 flex-1",
          props.resolvedTheme === "dark" ? "bg-[#0b0f14]" : "bg-[#fcfaf5]",
        )}
      >
        {!props.pane.activeFilePath ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            <div
              className={cn(
                "flex size-16 items-center justify-center rounded-2xl border shadow-inner",
                props.resolvedTheme === "dark"
                  ? "border-border/60 bg-white/[0.03]"
                  : "border-border/70 bg-white/80",
              )}
            >
              <FolderIcon className="size-7 text-muted-foreground/60" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Open a file in this window.</p>
              <p className="text-sm text-muted-foreground">
                Option-click a file in Explorer to route it into a new window without leaving your
                current one.
              </p>
            </div>
          </div>
        ) : props.gitCwd === null && !activeDraft ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">This workspace is unavailable.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                The current thread does not have an active project path.
              </p>
            </div>
          </div>
        ) : activeFileQuery.isPending && !activeDraft ? (
          <div className="space-y-4 px-6 py-6">
            <div className="h-5 w-52 rounded bg-foreground/6" />
            <div className="h-4 w-full rounded bg-foreground/4" />
            <div className="h-4 w-[88%] rounded bg-foreground/4" />
            <div className="h-4 w-[76%] rounded bg-foreground/4" />
          </div>
        ) : activeFileQuery.isError && !activeDraft ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">This file could not be opened.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeFileQuery.error instanceof Error
                  ? activeFileQuery.error.message
                  : "An unexpected error occurred."}
              </p>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 min-w-0">
            <Editor
              key={`${props.pane.id}:${props.pane.activeFilePath ?? "empty"}:${props.resolvedTheme}`}
              height="100%"
              path={props.pane.activeFilePath}
              value={activeFileContents}
              theme={props.resolvedTheme === "dark" ? "t3code-carbon" : "t3code-paper"}
              onMount={handleEditorMount}
              onChange={(value) => {
                if (!props.pane.activeFilePath || value === undefined) {
                  return;
                }
                props.onUpdateDraft(props.pane.activeFilePath, value);
              }}
              options={{
                automaticLayout: true,
                cursorBlinking: "smooth",
                fontLigatures: true,
                fontSize: 13.5,
                minimap: { enabled: false },
                padding: { top: 20, bottom: 24 },
                renderLineHighlightOnlyWhenFocus: true,
                roundedSelection: true,
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                stickyScroll: { enabled: true },
                tabSize: 2,
                wordWrap: "off",
              }}
            />
          </div>
        )}
      </div>

      <footer
        className={cn(
          "flex min-h-11 items-center justify-between gap-3 border-t px-3 text-[11px]",
          props.resolvedTheme === "dark"
            ? "border-border/50 bg-[#0d1218] text-muted-foreground"
            : "border-border/60 bg-[#f3ecdf] text-muted-foreground",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {props.pane.activeFilePath ? (
            <>
              <Badge
                variant="outline"
                className="min-w-0 max-w-64 truncate border-border/70 bg-transparent font-mono text-[10px]"
              >
                {props.pane.activeFilePath}
              </Badge>
              <span>{formatFileSize(activeFileSizeBytes)}</span>
              {activeFileDirty ? (
                <span className="font-semibold tracking-[0.18em] text-amber-600 uppercase">
                  Unsaved
                </span>
              ) : (
                <span className="tracking-[0.18em] uppercase">Synced</span>
              )}
            </>
          ) : (
            <span>Select a file from the explorer.</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {props.pane.activeFilePath && activeFileDirty ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
            >
              Revert
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              !props.pane.activeFilePath ||
              !activeFileDirty ||
              props.savingFilePath === props.pane.activeFilePath
            }
          >
            {props.savingFilePath === props.pane.activeFilePath ? "Saving..." : "Save"}
          </Button>
        </div>
      </footer>
    </section>
  );
}
