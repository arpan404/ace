import Editor, { type OnMount } from "@monaco-editor/react";
import type { WorkspaceEditorDiagnostic } from "@ace/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  Columns2Icon,
  FolderIcon,
  RefreshCwIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { openInPreferredEditor } from "~/editorPreferences";
import type { ThreadEditorPaneState } from "~/editorStateStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";

import ChatMarkdown from "../ChatMarkdown";
import MermaidDiagram from "../MermaidDiagram";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import {
  EDITOR_TAB_TRANSFER_TYPE,
  readEditorTabTransfer,
  readExplorerEntryTransfer,
} from "./dragTransfer";
import {
  buildWorkspacePreviewUrl,
  canOpenFileExternallyFromReadError,
  detectWorkspacePreviewKind,
  joinWorkspaceAbsolutePath,
  type WorkspacePreviewKind,
} from "./workspaceFileUtils";

interface WorkspaceEditorPaneProps {
  active: boolean;
  canClosePane: boolean;
  canReopenClosedTab: boolean;
  canSplitPane: boolean;
  diagnosticsCwd: string | null;
  dirtyFilePaths: ReadonlySet<string>;
  draftsByFilePath: Record<string, { draftContents: string; savedContents: string }>;
  editorOptions: MonacoEditor.IStandaloneEditorConstructionOptions;
  gitCwd: string | null;
  onCloseFile: (paneId: string, filePath: string) => void;
  onCloseOtherTabs: (paneId: string, filePath: string) => void;
  onClosePane: (paneId: string) => void;
  onCloseTabsToRight: (paneId: string, filePath: string) => void;
  onDiscardDraft: (filePath: string) => void;
  onFocusPane: (paneId: string) => void;
  onHydrateFile: (filePath: string, contents: string) => void;
  onMoveFile: (input: {
    filePath: string;
    sourcePaneId: string;
    targetPaneId: string;
    targetIndex?: number;
  }) => void;
  onOpenFileInPane: (paneId: string, filePath: string, targetIndex?: number) => void;
  onOpenFileToSide: (paneId: string, filePath: string) => void;
  onReopenClosedTab: (paneId: string) => void;
  onRetryActiveFile: () => void;
  onSaveFile: (relativePath: string, contents: string) => void;
  onSetActiveFile: (paneId: string, filePath: string | null) => void;
  onSplitPane: (paneId: string) => void;
  onSplitPaneDown: (paneId: string) => void;
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

const WORKSPACE_EDITOR_MARKER_OWNER = "ace-workspace-editor";
const MONACO_DIAGNOSTIC_OWNERS = [WORKSPACE_EDITOR_MARKER_OWNER] as const;
const DIAGNOSTIC_SYNC_DEBOUNCE_MS = 250;
const WORKSPACE_FILE_REFETCH_INTERVAL_MS = 1_200;
const MONACO_NATIVE_LSP_LANGUAGES = new Set([
  "css",
  "html",
  "javascript",
  "json",
  "less",
  "scss",
  "typescript",
]);

type MonacoApi = typeof import("monaco-editor");

function resolveMonacoLanguageFromFilePath(filePath: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const normalizedPath = filePath.toLowerCase();
  if (
    normalizedPath.endsWith(".ts") ||
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".mts") ||
    normalizedPath.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    normalizedPath.endsWith(".js") ||
    normalizedPath.endsWith(".jsx") ||
    normalizedPath.endsWith(".mjs") ||
    normalizedPath.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (normalizedPath.endsWith(".json")) {
    return "json";
  }
  if (normalizedPath.endsWith(".css")) {
    return "css";
  }
  if (normalizedPath.endsWith(".scss")) {
    return "scss";
  }
  if (normalizedPath.endsWith(".less")) {
    return "less";
  }
  if (normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm")) {
    return "html";
  }
  if (normalizedPath.endsWith(".md")) {
    return "markdown";
  }
  return undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseMonacoLanguageService(languageId: string): boolean {
  return MONACO_NATIVE_LSP_LANGUAGES.has(languageId);
}

function isUnavailableWorkspaceDiagnosticsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("neovim") ||
    message.includes("unable to spawn") ||
    message.includes("failed to initialize")
  );
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function toWorkspaceSeverity(
  monacoInstance: MonacoApi,
  severity: number,
): WorkspaceEditorDiagnostic["severity"] {
  if (severity === monacoInstance.MarkerSeverity.Warning) {
    return "warning";
  }
  if (severity === monacoInstance.MarkerSeverity.Info) {
    return "info";
  }
  if (severity === monacoInstance.MarkerSeverity.Hint) {
    return "hint";
  }
  return "error";
}

function formatProblemSummary(
  monacoInstance: MonacoApi,
  markers: readonly MonacoEditor.IMarker[],
): string | null {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let hintCount = 0;

  for (const marker of markers) {
    switch (toWorkspaceSeverity(monacoInstance, marker.severity)) {
      case "error":
        errorCount += 1;
        break;
      case "warning":
        warningCount += 1;
        break;
      case "info":
        infoCount += 1;
        break;
      case "hint":
        hintCount += 1;
        break;
      default:
    }
  }

  const parts = [
    errorCount > 0 ? `${errorCount} ${pluralize(errorCount, "error")}` : null,
    warningCount > 0 ? `${warningCount} ${pluralize(warningCount, "warning")}` : null,
    infoCount > 0 ? `${infoCount} ${pluralize(infoCount, "info")}` : null,
    hintCount > 0 ? `${hintCount} ${pluralize(hintCount, "hint")}` : null,
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? parts.join(", ") : null;
}

function severityFromMarkerValue(severity: number): WorkspaceEditorDiagnostic["severity"] {
  if (severity >= 8) {
    return "error";
  }
  if (severity >= 4) {
    return "warning";
  }
  if (severity >= 2) {
    return "info";
  }
  return "hint";
}

function toMonacoSeverity(
  monacoInstance: MonacoApi,
  severity: WorkspaceEditorDiagnostic["severity"],
) {
  switch (severity) {
    case "warning":
      return monacoInstance.MarkerSeverity.Warning;
    case "info":
      return monacoInstance.MarkerSeverity.Info;
    case "hint":
      return monacoInstance.MarkerSeverity.Hint;
    case "error":
    default:
      return monacoInstance.MarkerSeverity.Error;
  }
}

function toMonacoMarkers(
  monacoInstance: MonacoApi,
  diagnostics: readonly WorkspaceEditorDiagnostic[],
): MonacoEditor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const startLineNumber = diagnostic.startLine + 1;
    const startColumn = diagnostic.startColumn + 1;
    const endLineNumber = diagnostic.endLine + 1;
    const endColumn =
      diagnostic.endLine === diagnostic.startLine
        ? Math.max(startColumn + 1, diagnostic.endColumn + 1)
        : Math.max(1, diagnostic.endColumn + 1);

    const marker: MonacoEditor.IMarkerData = {
      endColumn,
      endLineNumber,
      message: diagnostic.message.trim().length > 0 ? diagnostic.message : "Language diagnostic",
      severity: toMonacoSeverity(monacoInstance, diagnostic.severity),
      startColumn,
      startLineNumber,
    };
    if (diagnostic.code !== undefined) {
      marker.code = diagnostic.code;
    }
    if (diagnostic.source !== undefined) {
      marker.source = diagnostic.source;
    }
    return marker;
  });
}

function clearModelMarkers(monacoInstance: MonacoApi, model: MonacoEditor.ITextModel): void {
  for (const owner of MONACO_DIAGNOSTIC_OWNERS) {
    monacoInstance.editor.setModelMarkers(model, owner, []);
  }
}

export default function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
  const api = readNativeApi();
  const pane = props.pane;
  const canReopenClosedTab = props.canReopenClosedTab;
  const onFocusPane = props.onFocusPane;
  const onHydrateFile = props.onHydrateFile;
  const onMoveFile = props.onMoveFile;
  const onCloseFile = props.onCloseFile;
  const onCloseOtherTabs = props.onCloseOtherTabs;
  const onCloseTabsToRight = props.onCloseTabsToRight;
  const onOpenFileToSide = props.onOpenFileToSide;
  const onOpenFileInPane = props.onOpenFileInPane;
  const onReopenClosedTab = props.onReopenClosedTab;
  const onSaveFile = props.onSaveFile;
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [diagnosticSummary, setDiagnosticSummary] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [problems, setProblems] = useState<readonly MonacoEditor.IMarker[]>([]);
  const [editorMountVersion, setEditorMountVersion] = useState(0);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const syncRequestIdRef = useRef(0);
  const diagnosticsBackendUnavailableRef = useRef(false);
  const activePreviewKind = useMemo<WorkspacePreviewKind | null>(
    () => (pane.activeFilePath ? detectWorkspacePreviewKind(pane.activeFilePath) : null),
    [pane.activeFilePath],
  );
  const isBinaryPreviewMode = activePreviewKind === "image" || activePreviewKind === "video";
  const isTextPreviewMode = activePreviewKind === "markdown" || activePreviewKind === "mermaid";
  const isPreviewMode =
    (isBinaryPreviewMode || isTextPreviewMode) &&
    pane.activeFilePath !== null &&
    props.gitCwd !== null;
  const activeDraftInStore =
    !isPreviewMode && pane.activeFilePath
      ? (props.draftsByFilePath[pane.activeFilePath] ?? null)
      : null;
  const hasUnsavedBufferEdits = activeDraftInStore
    ? activeDraftInStore.draftContents !== activeDraftInStore.savedContents
    : false;
  const activeFileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.gitCwd,
      relativePath: pane.activeFilePath,
      enabled:
        pane.activeFilePath !== null &&
        props.gitCwd !== null &&
        (!isPreviewMode || isTextPreviewMode),
      refetchInterval: hasUnsavedBufferEdits ? false : WORKSPACE_FILE_REFETCH_INTERVAL_MS,
      staleTime: 0,
    }),
  );

  useEffect(() => {
    if (isPreviewMode || !pane.activeFilePath || activeFileQuery.data?.contents === undefined) {
      return;
    }
    onHydrateFile(pane.activeFilePath, activeFileQuery.data.contents);
  }, [activeFileQuery.data?.contents, isPreviewMode, onHydrateFile, pane.activeFilePath]);

  const activeDraft =
    isPreviewMode || !pane.activeFilePath
      ? null
      : (props.draftsByFilePath[pane.activeFilePath] ?? null);
  const activeFileContents = activeDraft?.draftContents ?? activeFileQuery.data?.contents ?? "";
  const activeFileDirty = activeDraft
    ? activeDraft.draftContents !== activeDraft.savedContents
    : false;
  const activeFileSizeBytes = isPreviewMode
    ? null
    : (activeFileQuery.data?.sizeBytes ?? new Blob([activeFileContents]).size);
  const previewUrl =
    isBinaryPreviewMode && pane.activeFilePath && props.gitCwd
      ? buildWorkspacePreviewUrl(props.gitCwd, pane.activeFilePath)
      : null;
  const previewModeLabel =
    activePreviewKind === "markdown"
      ? "Markdown preview"
      : activePreviewKind === "mermaid"
        ? "Mermaid preview"
        : "Preview mode";
  const activeMonacoLanguage = resolveMonacoLanguageFromFilePath(props.pane.activeFilePath);

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

  const clearEditorMarkers = useCallback(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoInstance || !model) {
      return;
    }
    clearModelMarkers(monacoInstance, model);
  }, []);

  const syncProblemState = useCallback(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoInstance || !model) {
      setProblems([]);
      setDiagnosticSummary(null);
      return;
    }
    const nextProblems = monacoInstance.editor.getModelMarkers({ resource: model.uri });
    setProblems(nextProblems);
    setDiagnosticSummary(formatProblemSummary(monacoInstance, nextProblems));
  }, []);

  const activeFileReady =
    pane.activeFilePath !== null &&
    (isPreviewMode || activeDraft !== null || activeFileQuery.data?.contents !== undefined);

  const handleEditorMount = useCallback<OnMount>(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;
      setEditorMountVersion((version) => version + 1);
      editor.onDidFocusEditorWidget(() => {
        onFocusPane(pane.id);
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        saveActionRef.current();
      });
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyM,
        () => {
          setProblemsOpen((open) => !open);
        },
      );
      editor.onDidDispose(() => {
        editorRef.current = null;
        monacoRef.current = null;
      });
      syncProblemState();
    },
    [onFocusPane, pane.id, syncProblemState],
  );

  useEffect(() => {
    syncRequestIdRef.current += 1;
    const requestId = syncRequestIdRef.current;

    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const activeFilePath = pane.activeFilePath;
    const model = editor?.getModel();

    if (
      isPreviewMode ||
      !api ||
      !props.diagnosticsCwd ||
      !activeFilePath ||
      !activeFileReady ||
      !editor ||
      !monacoInstance ||
      !model
    ) {
      clearEditorMarkers();
      setDiagnosticError(null);
      syncProblemState();
      return;
    }

    if (
      diagnosticsBackendUnavailableRef.current ||
      shouldUseMonacoLanguageService(model.getLanguageId())
    ) {
      clearModelMarkers(monacoInstance, model);
      setDiagnosticError(null);
      syncProblemState();
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void api.workspaceEditor
        .syncBuffer({
          cwd: props.diagnosticsCwd!,
          relativePath: activeFilePath,
          contents: activeFileContents,
        })
        .then((result) => {
          if (syncRequestIdRef.current !== requestId) {
            return;
          }

          const liveEditor = editorRef.current;
          const liveMonaco = monacoRef.current;
          const liveModel = liveEditor?.getModel();
          if (
            !liveEditor ||
            !liveMonaco ||
            !liveModel ||
            liveModel.uri.toString() !== model.uri.toString()
          ) {
            return;
          }

          clearModelMarkers(liveMonaco, liveModel);
          liveMonaco.editor.setModelMarkers(
            liveModel,
            WORKSPACE_EDITOR_MARKER_OWNER,
            toMonacoMarkers(liveMonaco, result.diagnostics),
          );
          setDiagnosticError(null);
          const nextProblems = liveMonaco.editor.getModelMarkers({ resource: liveModel.uri });
          setProblems(nextProblems);
          setDiagnosticSummary(formatProblemSummary(liveMonaco, nextProblems));
        })
        .catch((error) => {
          if (syncRequestIdRef.current !== requestId) {
            return;
          }
          clearEditorMarkers();
          if (isUnavailableWorkspaceDiagnosticsError(error)) {
            diagnosticsBackendUnavailableRef.current = true;
            setDiagnosticError(null);
          } else {
            const message = toErrorMessage(error);
            setDiagnosticError(message);
          }
          syncProblemState();
          if (!diagnosticsBackendUnavailableRef.current) {
            console.error("Failed to sync workspace editor diagnostics", {
              cwd: props.gitCwd,
              diagnosticsCwd: props.diagnosticsCwd,
              relativePath: activeFilePath,
              error,
            });
          }
        });
    }, DIAGNOSTIC_SYNC_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeFileContents,
    activeFileReady,
    api,
    clearEditorMarkers,
    editorMountVersion,
    isPreviewMode,
    pane.activeFilePath,
    props.diagnosticsCwd,
    props.gitCwd,
    syncProblemState,
  ]);

  useEffect(() => {
    const monacoInstance = monacoRef.current;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!monacoInstance || !editor || !model) {
      setProblems([]);
      setDiagnosticSummary(null);
      return;
    }

    const modelUri = model.uri.toString();
    syncProblemState();
    const disposable = monacoInstance.editor.onDidChangeMarkers((uris) => {
      if (!uris.some((uri) => uri.toString() === modelUri)) {
        return;
      }
      syncProblemState();
    });

    return () => {
      disposable.dispose();
    };
  }, [editorMountVersion, pane.activeFilePath, syncProblemState]);

  useEffect(
    () => () => {
      syncRequestIdRef.current += 1;
      clearEditorMarkers();
    },
    [clearEditorMarkers],
  );

  useEffect(() => {
    diagnosticsBackendUnavailableRef.current = false;
  }, [pane.activeFilePath, props.diagnosticsCwd]);

  const readDraggedTab = useCallback((event: ReactDragEvent<HTMLElement>) => {
    return readEditorTabTransfer(event.dataTransfer);
  }, []);
  const readDraggedExplorerEntry = useCallback((event: ReactDragEvent<HTMLElement>) => {
    return readExplorerEntryTransfer(event.dataTransfer);
  }, []);

  const handleTabDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetIndex?: number) => {
      const draggedTab = readDraggedTab(event);
      if (draggedTab) {
        event.preventDefault();
        setDropTargetIndex(null);
        onMoveFile({
          ...draggedTab,
          targetPaneId: pane.id,
          ...(targetIndex === undefined ? {} : { targetIndex }),
        });
        return;
      }
      const draggedEntry = readDraggedExplorerEntry(event);
      if (!draggedEntry || draggedEntry.kind !== "file") {
        return;
      }
      event.preventDefault();
      setDropTargetIndex(null);
      onOpenFileInPane(pane.id, draggedEntry.path, targetIndex);
    },
    [onMoveFile, onOpenFileInPane, pane.id, readDraggedExplorerEntry, readDraggedTab],
  );

  const handleTabDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetIndex?: number) => {
      const draggedTab = readDraggedTab(event);
      if (draggedTab) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTargetIndex(targetIndex ?? pane.openFilePaths.length);
        return;
      }
      const draggedEntry = readDraggedExplorerEntry(event);
      if (!draggedEntry || draggedEntry.kind !== "file") {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropTargetIndex(targetIndex ?? pane.openFilePaths.length);
    },
    [pane.openFilePaths.length, readDraggedExplorerEntry, readDraggedTab],
  );

  const clearDropTarget = useCallback(() => {
    setDropTargetIndex(null);
  }, []);

  const openTabContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLButtonElement>, filePath: string) => {
      if (!api) {
        return;
      }

      const tabIndex = pane.openFilePaths.indexOf(filePath);
      if (tabIndex < 0) {
        return;
      }

      const items = [
        { id: "open-side", label: `Open ${basenameOfPath(filePath)} to the Side` },
        { id: "close", label: `Close ${basenameOfPath(filePath)}` },
        {
          id: "close-others",
          label: "Close Other Tabs",
          disabled: pane.openFilePaths.length <= 1,
        },
        {
          id: "close-right",
          label: "Close Tabs to the Right",
          disabled: tabIndex >= pane.openFilePaths.length - 1,
        },
        {
          id: "reopen-closed",
          label: "Reopen Closed Tab",
          disabled: !canReopenClosedTab,
        },
      ] as const;

      const clicked = await api.contextMenu.show(items, {
        x: event.clientX,
        y: event.clientY,
      });

      switch (clicked) {
        case "open-side":
          onOpenFileToSide(pane.id, filePath);
          return;
        case "close":
          onCloseFile(pane.id, filePath);
          return;
        case "close-others":
          onCloseOtherTabs(pane.id, filePath);
          return;
        case "close-right":
          onCloseTabsToRight(pane.id, filePath);
          return;
        case "reopen-closed":
          onReopenClosedTab(pane.id);
          return;
        default:
      }
    },
    [
      api,
      canReopenClosedTab,
      onCloseFile,
      onCloseOtherTabs,
      onCloseTabsToRight,
      onOpenFileToSide,
      onReopenClosedTab,
      pane.id,
      pane.openFilePaths,
    ],
  );

  const sortedProblems = useMemo(
    () =>
      problems.toSorted((left, right) => {
        if (left.severity !== right.severity) {
          return right.severity - left.severity;
        }
        if (left.startLineNumber !== right.startLineNumber) {
          return left.startLineNumber - right.startLineNumber;
        }
        return left.startColumn - right.startColumn;
      }),
    [problems],
  );

  const handleProblemClick = useCallback((problem: MonacoEditor.IMarker) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    editor.focus();
    editor.setPosition({
      lineNumber: problem.startLineNumber,
      column: problem.startColumn,
    });
    editor.revealPositionInCenter({
      lineNumber: problem.startLineNumber,
      column: problem.startColumn,
    });
  }, []);

  const handleOpenInExternalEditor = useCallback(async () => {
    if (!api || !props.gitCwd || !pane.activeFilePath) {
      return;
    }
    try {
      setActionError(null);
      await openInPreferredEditor(
        api,
        joinWorkspaceAbsolutePath(props.gitCwd, pane.activeFilePath),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to open file in editor.");
    }
  }, [api, pane.activeFilePath, props.gitCwd]);

  useEffect(() => {
    setActionError(null);
    setPreviewError(null);
    setProblemsOpen(false);
  }, [pane.activeFilePath]);

  const activeFileErrorMessage =
    activeFileQuery.error instanceof Error
      ? activeFileQuery.error.message
      : "An unexpected error occurred.";
  const canOpenAnyway =
    activeFileQuery.isError && canOpenFileExternallyFromReadError(activeFileErrorMessage);

  return (
    <section
      data-pane-active={props.active ? "true" : "false"}
      className={cn(
        "group flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-colors relative",
        "bg-background",
      )}
      onPointerDown={() => {
        props.onFocusPane(props.pane.id);
      }}
    >
      <div
        className={cn(
          "flex h-[35px] shrink-0 items-center overflow-x-auto scrollbar-none border-b border-border/40",
          "bg-secondary/80",
        )}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          clearDropTarget();
        }}
        onDragOver={(event) => handleTabDragOver(event)}
        onDrop={(event) => handleTabDrop(event)}
      >
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none">
          {props.pane.openFilePaths.map((filePath) => {
            const isActive = filePath === props.pane.activeFilePath;
            const isDirty = props.dirtyFilePaths.has(filePath);
            return (
              <div key={filePath} className="relative flex shrink-0">
                {dropTargetIndex === props.pane.openFilePaths.indexOf(filePath) ? (
                  <div className="absolute top-1.5 bottom-1.5 left-0 z-20 w-[2px] rounded-full bg-primary" />
                ) : null}
                <button
                  type="button"
                  data-editor-tab="true"
                  className={cn(
                    "group/tab flex h-[35px] shrink-0 items-center gap-1.5 border-r border-border/30 px-3 text-[12px] transition-colors relative",
                    isActive
                      ? "bg-background text-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                  draggable
                  onClick={() => props.onSetActiveFile(props.pane.id, filePath)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    props.onSetActiveFile(props.pane.id, filePath);
                    void openTabContextMenu(event, filePath);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) {
                      return;
                    }
                    event.preventDefault();
                    props.onCloseFile(props.pane.id, filePath);
                  }}
                  onDragStart={(event) => {
                    props.onFocusPane(props.pane.id);
                    event.dataTransfer.effectAllowed = "move";
                    const payload = JSON.stringify({
                      filePath,
                      sourcePaneId: props.pane.id,
                    });
                    event.dataTransfer.setData(EDITOR_TAB_TRANSFER_TYPE, payload);
                    event.dataTransfer.setData("text/plain", payload);
                  }}
                  onDragEnd={clearDropTarget}
                  onDragOver={(event) =>
                    handleTabDragOver(event, props.pane.openFilePaths.indexOf(filePath))
                  }
                  onDrop={(event) =>
                    handleTabDrop(event, props.pane.openFilePaths.indexOf(filePath))
                  }
                  title={filePath}
                >
                  {isActive && (
                    <div className="absolute bottom-0 left-0 h-px w-full bg-background" />
                  )}
                  <VscodeEntryIcon
                    pathValue={filePath}
                    kind="file"
                    theme={props.resolvedTheme}
                    className="size-[14px] shrink-0"
                  />
                  <span className="max-w-[140px] truncate">{basenameOfPath(filePath)}</span>
                  {isDirty ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground/40 group-hover/tab:hidden" />
                  ) : null}
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-foreground/10 group-hover/tab:opacity-100",
                      isDirty ? "hidden group-hover/tab:flex" : "",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onCloseFile(props.pane.id, filePath);
                    }}
                  >
                    <XIcon className="size-3" />
                  </span>
                </button>
              </div>
            );
          })}
          {dropTargetIndex === props.pane.openFilePaths.length ? (
            <div className="relative flex shrink-0 items-stretch px-0.5">
              <div className="my-1.5 w-[2px] rounded-full bg-primary" />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
            onClick={() => props.onSplitPane(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Right"
          >
            <Columns2Icon className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
            onClick={() => props.onSplitPaneDown(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Down"
          >
            <Rows2Icon className="size-3" />
          </Button>
          {props.canClosePane ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 rounded text-muted-foreground/70 hover:text-foreground"
              onClick={() => props.onClosePane(props.pane.id)}
              title="Close Editor Group"
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn("min-h-0 min-w-0 flex-1 relative border-t border-border/40", "bg-background")}
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
        ) : isBinaryPreviewMode && previewUrl ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="flex h-full min-h-[220px] items-center justify-center rounded-xl border border-border/50 bg-secondary/30">
                {activePreviewKind === "image" ? (
                  <img
                    src={previewUrl}
                    alt={props.pane.activeFilePath}
                    className="max-h-full max-w-full object-contain"
                    onError={() => {
                      setPreviewError("Unable to preview this image in the embedded editor.");
                    }}
                  />
                ) : (
                  <video
                    src={previewUrl}
                    controls
                    className="max-h-full max-w-full"
                    onError={() => {
                      setPreviewError("Unable to preview this video in the embedded editor.");
                    }}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate">{previewModeLabel}</span>
              <Button size="sm" variant="outline" onClick={() => void handleOpenInExternalEditor()}>
                Open in Editor
              </Button>
            </div>
          </div>
        ) : isTextPreviewMode && activeFileQuery.data?.contents !== undefined ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className="min-h-[220px] rounded-xl border border-border/50 bg-secondary/30 p-4">
                {activePreviewKind === "markdown" ? (
                  <ChatMarkdown
                    text={activeFileQuery.data.contents}
                    cwd={props.gitCwd ?? undefined}
                    isStreaming={false}
                  />
                ) : (
                  <MermaidDiagram
                    source={activeFileQuery.data.contents}
                    theme={props.resolvedTheme}
                    className="h-full"
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate">{previewModeLabel}</span>
              <Button size="sm" variant="outline" onClick={() => void handleOpenInExternalEditor()}>
                Open in Editor
              </Button>
            </div>
          </div>
        ) : activeFileQuery.isPending && !activeDraft ? (
          <div className="space-y-4 px-6 py-6">
            <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Opening file
            </p>
            <div className="h-5 w-52 rounded bg-foreground/6" />
            <div className="h-4 w-full rounded bg-foreground/4" />
            <div className="h-4 w-[88%] rounded bg-foreground/4" />
            <div className="h-4 w-[76%] rounded bg-foreground/4" />
          </div>
        ) : activeFileQuery.isError && !activeDraft ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertCircleIcon className="size-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                This file could not be opened.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{activeFileErrorMessage}</p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={props.onRetryActiveFile}>
                  <RefreshCwIcon className="size-3.5" />
                  Retry
                </Button>
                {canOpenAnyway ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleOpenInExternalEditor()}
                  >
                    Open Anyway
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 min-w-0">
            <Editor
              key={`${props.pane.id}:${props.pane.activeFilePath ?? "empty"}:${props.resolvedTheme}`}
              height="100%"
              path={props.pane.activeFilePath}
              value={activeFileContents}
              theme={props.resolvedTheme === "dark" ? "ace-carbon" : "ace-paper"}
              onMount={handleEditorMount}
              onChange={(value) => {
                if (!props.pane.activeFilePath || value === undefined) {
                  return;
                }
                props.onUpdateDraft(props.pane.activeFilePath, value);
              }}
              options={props.editorOptions}
              {...(activeMonacoLanguage ? { language: activeMonacoLanguage } : {})}
            />
          </div>
        )}
      </div>

      {!isPreviewMode && problemsOpen ? (
        <section className="shrink-0 border-t border-border/40 bg-secondary/50">
          <header className="flex h-7 items-center justify-between px-2.5 text-[11px] text-muted-foreground">
            <span className="font-medium">Problems</span>
            <span>{sortedProblems.length}</span>
          </header>
          <div className="max-h-44 overflow-y-auto border-t border-border/30">
            {sortedProblems.length > 0 ? (
              <div className="py-1">
                {sortedProblems.map((problem) => {
                  const severity = severityFromMarkerValue(problem.severity);
                  return (
                    <button
                      key={`${problem.owner}:${problem.startLineNumber}:${problem.startColumn}:${problem.message}`}
                      type="button"
                      className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-foreground/5"
                      onClick={() => handleProblemClick(problem)}
                    >
                      <span
                        className={cn(
                          "mt-0.5 inline-flex min-w-[3.6rem] rounded px-1 py-px text-[9px] font-semibold uppercase",
                          severity === "error" && "bg-destructive/15 text-destructive",
                          severity === "warning" && "bg-amber-500/15 text-amber-600",
                          severity === "info" && "bg-sky-500/15 text-sky-600",
                          severity === "hint" && "bg-foreground/10 text-muted-foreground",
                        )}
                      >
                        {severity}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-foreground">{problem.message}</span>
                        <span className="block truncate text-muted-foreground/80">
                          {problem.source ?? problem.owner} · Ln {problem.startLineNumber}, Col{" "}
                          {problem.startColumn}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="px-2.5 py-2 text-[11px] text-muted-foreground">No problems detected.</p>
            )}
          </div>
        </section>
      ) : null}

      <footer className="flex h-[22px] shrink-0 items-center justify-between gap-3 border-t border-border/30 bg-secondary/60 px-2.5 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
          {props.pane.activeFilePath ? (
            <>
              <span className="truncate">{props.pane.activeFilePath}</span>
              {activeFileSizeBytes !== null ? (
                <span className="shrink-0 opacity-60">{formatFileSize(activeFileSizeBytes)}</span>
              ) : null}
              {activeFileDirty ? (
                <span className="shrink-0 rounded-sm bg-primary/15 px-1 py-px text-[9px] font-semibold tracking-wider text-primary uppercase">
                  Modified
                </span>
              ) : null}
            </>
          ) : (
            <span className="opacity-60">Ready</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {actionError ? (
            <span className="max-w-[18rem] truncate text-destructive/80" title={actionError}>
              {actionError}
            </span>
          ) : null}
          {previewError ? (
            <span className="max-w-[18rem] truncate text-destructive/80" title={previewError}>
              {previewError}
            </span>
          ) : null}
          {diagnosticError ? (
            <span className="max-w-[18rem] truncate text-destructive/80" title={diagnosticError}>
              {diagnosticError}
            </span>
          ) : null}
          {props.pane.activeFilePath && !isPreviewMode ? (
            <button
              type="button"
              className="opacity-70 transition-opacity hover:opacity-100 hover:text-foreground"
              onClick={() => {
                setProblemsOpen((open) => !open);
              }}
              title={
                diagnosticSummary
                  ? `${diagnosticSummary}. ${problemsOpen ? "Hide" : "Show"} problems panel`
                  : `${problemsOpen ? "Hide" : "Show"} problems panel`
              }
            >
              {diagnosticSummary ?? "No problems"}
            </button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              type="button"
              className="opacity-60 hover:opacity-100 transition-opacity hover:text-foreground"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
            >
              Revert
            </button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              type="button"
              className="font-medium opacity-80 hover:opacity-100 transition-opacity hover:text-foreground"
              onClick={handleSave}
              disabled={props.savingFilePath === props.pane.activeFilePath}
            >
              {props.savingFilePath === props.pane.activeFilePath ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
