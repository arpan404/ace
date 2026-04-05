import Editor, { type OnMount } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { Columns2Icon, FolderIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThreadEditorPaneState } from "~/editorStateStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "~/vscode-icons";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
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
        "group flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-colors relative",
        props.resolvedTheme === "dark" ? "bg-[#0b0d10]" : "bg-[#fcfaf5]",
        props.active ? "ring-1 ring-inset ring-primary/20" : "",
      )}
      onPointerDown={() => {
        props.onFocusPane(props.pane.id);
      }}
    >
      <div
        className={cn(
          "flex h-[38px] shrink-0 overflow-x-auto scrollbar-none",
          props.resolvedTheme === "dark" ? "bg-[#18181b]" : "bg-[#f3f4f6]",
        )}
      >
        {props.pane.openFilePaths.map((filePath) => {
          const isActive = filePath === props.pane.activeFilePath;
          const isDirty = props.dirtyFilePaths.has(filePath);
          return (
            <button
              key={filePath}
              type="button"
              className={cn(
                "group/tab flex h-full shrink-0 items-center gap-2 border-r border-border/40 px-3 text-[13px] transition-colors relative",
                isActive
                  ? props.resolvedTheme === "dark"
                    ? "bg-[#0b0d10] text-foreground"
                    : "bg-[#fcfaf5] text-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
              onClick={() => props.onSetActiveFile(props.pane.id, filePath)}
              title={filePath}
            >
              {isActive && <div className="absolute top-0 left-0 h-[2px] w-full bg-primary" />}
              <VscodeEntryIcon
                pathValue={filePath}
                kind="file"
                theme={props.resolvedTheme}
                className="size-[14px] shrink-0"
              />
              <span className="max-w-[160px] truncate">{basenameOfPath(filePath)}</span>
              {isDirty ? (
                <span className="size-2 shrink-0 rounded-full bg-foreground/30 group-hover/tab:hidden" />
              ) : null}
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100",
                  isDirty ? "hidden group-hover/tab:flex" : "",
                )}
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

      <div
        className={cn(
          "flex h-7 shrink-0 items-center justify-between px-3",
          props.resolvedTheme === "dark" ? "bg-[#0b0d10]" : "bg-[#fcfaf5]",
        )}
      >
        <div className="flex min-w-0 items-center">
          {props.pane.activeFilePath ? (
            <FilePathBreadcrumbs pathValue={props.pane.activeFilePath} />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded"
            onClick={() => props.onSplitPane(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Right"
          >
            <Columns2Icon className="size-[13px]" />
          </Button>
          {props.canClosePane ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 rounded"
              onClick={() => props.onClosePane(props.pane.id)}
              title="Close Editor Group"
            >
              <XIcon className="size-[13px]" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 relative border-t border-border/40",
          props.resolvedTheme === "dark" ? "bg-[#0b0d10]" : "bg-[#fcfaf5]",
        )}
      >
        {!props.pane.activeFilePath ? (
          <div className="flex h-full items-center justify-center">
            <div className="opacity-[0.03] pointer-events-none text-foreground flex items-center justify-center">
              <FolderIcon className="size-24" strokeWidth={1} />
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
                padding: { top: 12, bottom: 24 },
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
          "flex h-[26px] items-center justify-between gap-3 border-t px-3 text-[11px]",
          props.resolvedTheme === "dark"
            ? "border-border/40 bg-[#007acc] text-white"
            : "border-border/40 bg-[#007acc] text-white",
        )}
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {props.pane.activeFilePath ? (
            <>
              <span className="font-medium truncate">
                {basenameOfPath(props.pane.activeFilePath)}
              </span>
              <span>{formatFileSize(activeFileSizeBytes)}</span>
              {activeFileDirty ? (
                <span className="font-bold tracking-wider opacity-80 uppercase text-[9px]">
                  Unsaved
                </span>
              ) : null}
            </>
          ) : (
            <span>Ready</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              className="opacity-80 hover:opacity-100 transition-opacity"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
            >
              Revert
            </button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              className="opacity-80 hover:opacity-100 transition-opacity font-medium"
              onClick={handleSave}
              disabled={props.savingFilePath === props.pane.activeFilePath}
            >
              {props.savingFilePath === props.pane.activeFilePath ? "Saving..." : "Save"}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
