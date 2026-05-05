import Editor, { type OnMount } from "@monaco-editor/react";
import type { WorkspaceEditorDiagnostic, WorkspaceEditorLocation } from "@ace/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  ArrowUpRightIcon,
  Columns2Icon,
  EyeIcon,
  FolderIcon,
  PencilIcon,
  RefreshCwIcon,
  Rows2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ThreadEditorPaneState } from "~/editorStateStore";
import { withRpcRouteConnection } from "~/lib/connectionRouting";
import { resolveMonacoLanguageFromFilePath } from "~/lib/editor/workspaceLanguageMapping";
import {
  buildWorkspaceSelectionContext,
  countOpenWorkspaceCodeComments,
  createWorkspaceCodeComment,
  type WorkspaceCodeComment,
  type WorkspaceSelectionContext,
} from "~/lib/editor/workspaceDesigner";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";

import ChatMarkdown from "../ChatMarkdown";
import MermaidDiagram from "../MermaidDiagram";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EDITOR_TAB_TRANSFER_TYPE,
  readEditorTabTransfer,
  readExplorerEntryTransfer,
} from "./dragTransfer";
import {
  buildWorkspacePreviewUrl,
  detectWorkspacePreviewKind,
  type WorkspacePreviewKind,
} from "./workspaceFileUtils";

interface WorkspaceEditorPaneProps {
  active: boolean;
  canClosePane: boolean;
  canReopenClosedTab: boolean;
  canSplitPane: boolean;
  chromeActions?: ReactNode;
  connectionUrl?: string | null | undefined;
  diagnosticsCwd: string | null;
  dirtyFilePaths: ReadonlySet<string>;
  draftsByFilePath: Record<string, { draftContents: string; savedContents: string }>;
  editorOptions: MonacoEditor.IStandaloneEditorConstructionOptions;
  gitCwd: string | null;
  codeComments: readonly WorkspaceCodeComment[];
  onAddCodeComment: (comment: WorkspaceCodeComment) => void;
  onAddCodeCommentAndSend?: (comment: WorkspaceCodeComment) => Promise<boolean> | boolean;
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
  onProblemsChange: (
    paneId: string,
    activeFilePath: string | null,
    problems: readonly WorkspaceEditorPaneProblem[],
  ) => void;
  onSymbolsChange: (
    paneId: string,
    activeFilePath: string | null,
    symbols: readonly WorkspaceEditorPaneSymbol[],
  ) => void;
  onQueueSelectionContext: (context: WorkspaceSelectionContext, prompt: string) => void;
  onReopenClosedTab: (paneId: string) => void;
  onRetryActiveFile: () => void;
  onSaveFile: (relativePath: string, contents: string) => void;
  onSetActiveFile: (paneId: string, filePath: string | null) => void;
  onSplitPane: (paneId: string) => void;
  onSplitPaneDown: (paneId: string) => void;
  onUpdateDraft: (filePath: string, contents: string) => void;
  monacoTheme: string;
  pane: ThreadEditorPaneState;
  paneIndex: number;
  resolvedTheme: "light" | "dark";
  savingFilePath: string | null;
  problemNavigationTarget: WorkspaceEditorProblemNavigationTarget | null;
  symbolNavigationTarget: WorkspaceEditorSymbolNavigationTarget | null;
  findRequestToken?: number;
}

export interface WorkspaceEditorPaneProblem {
  readonly code?: string | number;
  readonly endColumn: number;
  readonly endLineNumber: number;
  readonly message: string;
  readonly owner: string;
  readonly severity: number;
  readonly source?: string;
  readonly startColumn: number;
  readonly startLineNumber: number;
}

export interface WorkspaceEditorProblemNavigationTarget {
  readonly id: number;
  readonly location: WorkspaceEditorLocation;
}

export interface WorkspaceEditorPaneSymbol {
  readonly depth: number;
  readonly detail?: string;
  readonly endColumn: number;
  readonly endLineNumber: number;
  readonly kind: string;
  readonly name: string;
  readonly startColumn: number;
  readonly startLineNumber: number;
}

export interface WorkspaceEditorSymbolNavigationTarget {
  readonly id: number;
  readonly location: WorkspaceEditorLocation;
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
const DIAGNOSTIC_UNAVAILABLE_RETRY_MS = 3_000;
const WORKSPACE_FILE_REFETCH_INTERVAL_MS = 5_000;
const COMPLETION_TRIGGER_CHARACTERS = [".", "/", '"', "'", ":", "<", "@"] as const;
const WORKSPACE_MODEL_URI_SCHEME = "ace-workspace";

type MonacoApi = typeof import("monaco-editor");

interface ActiveSelectionState {
  readonly id: string;
  readonly context: WorkspaceSelectionContext;
  readonly top: number;
  readonly left: number;
}

function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath
    .split(/[\\/]/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

function createWorkspaceModelUriString(relativePath: string): string {
  const encodedPath = normalizeWorkspaceRelativePath(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${WORKSPACE_MODEL_URI_SCHEME}:///${encodedPath}`;
}

function createWorkspaceModelUri(monacoInstance: MonacoApi, relativePath: string) {
  return monacoInstance.Uri.parse(createWorkspaceModelUriString(relativePath));
}

function readRelativePathFromWorkspaceModelUri(uri: {
  scheme: string;
  path: string;
}): string | null {
  if (uri.scheme !== WORKSPACE_MODEL_URI_SCHEME) {
    return null;
  }
  const relativePath = uri.path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  return relativePath.length > 0 ? relativePath : null;
}

function toMonacoRangeFromWorkspaceLocation(location: WorkspaceEditorLocation) {
  const startLineNumber = location.startLine + 1;
  const startColumn = location.startColumn + 1;
  const endLineNumber = location.endLine + 1;
  const endColumn =
    location.endLine === location.startLine
      ? Math.max(startColumn + 1, location.endColumn + 1)
      : Math.max(1, location.endColumn + 1);
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
  };
}

function toWorkspaceLocationFromSelection(
  relativePath: string,
  selection: {
    selectionStartLineNumber: number;
    selectionStartColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
): WorkspaceEditorLocation {
  return {
    relativePath,
    startLine: Math.max(0, selection.selectionStartLineNumber - 1),
    startColumn: Math.max(0, selection.selectionStartColumn - 1),
    endLine: Math.max(0, selection.endLineNumber - 1),
    endColumn: Math.max(selection.endColumn - 1, selection.selectionStartColumn - 1),
  };
}

function workspaceSelectionId(input: {
  relativePath: string;
  selection: {
    selectionStartLineNumber: number;
    selectionStartColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}): string {
  return [
    input.relativePath,
    input.selection.selectionStartLineNumber,
    input.selection.selectionStartColumn,
    input.selection.endLineNumber,
    input.selection.endColumn,
  ].join(":");
}

function resolveRelativePathFromEditorModel(
  model: MonacoEditor.ITextModel,
  fallbackRelativePath: string | null,
): string | null {
  const fromWorkspaceUri = readRelativePathFromWorkspaceModelUri(model.uri);
  if (fromWorkspaceUri) {
    return fromWorkspaceUri;
  }
  return fallbackRelativePath;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailableWorkspaceDiagnosticsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("workspace diagnostics backend unavailable") ||
    message.includes("language server restart is cooling down") ||
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

function toWorkspaceEditorPaneProblem(marker: MonacoEditor.IMarker): WorkspaceEditorPaneProblem {
  const problem: {
    code?: string | number;
    endColumn: number;
    endLineNumber: number;
    message: string;
    owner: string;
    severity: number;
    source?: string;
    startColumn: number;
    startLineNumber: number;
  } = {
    endColumn: marker.endColumn,
    endLineNumber: marker.endLineNumber,
    message: marker.message,
    owner: marker.owner,
    severity: marker.severity,
    startColumn: marker.startColumn,
    startLineNumber: marker.startLineNumber,
  };

  if (typeof marker.code === "string" || typeof marker.code === "number") {
    problem.code = marker.code;
  }
  if (marker.source) {
    problem.source = marker.source;
  }

  return problem;
}

function createWorkspaceEditorPaneSymbol(input: {
  detail?: string;
  kind: string;
  line: string;
  lineNumber: number;
  matchIndex: number;
  name: string;
}): WorkspaceEditorPaneSymbol {
  const indentation = input.line.match(/^\s*/u)?.[0].length ?? 0;
  const startColumn = input.matchIndex + 1;
  const symbol: {
    depth: number;
    detail?: string;
    endColumn: number;
    endLineNumber: number;
    kind: string;
    name: string;
    startColumn: number;
    startLineNumber: number;
  } = {
    depth: Math.min(6, Math.floor(indentation / 2)),
    endColumn: Math.max(startColumn + input.name.length, input.line.trimEnd().length + 1),
    endLineNumber: input.lineNumber,
    kind: input.kind,
    name: input.name,
    startColumn,
    startLineNumber: input.lineNumber,
  };
  if (input.detail) {
    symbol.detail = input.detail;
  }
  return symbol;
}

function extractWorkspaceEditorPaneSymbols(
  model: MonacoEditor.ITextModel,
): WorkspaceEditorPaneSymbol[] {
  const symbols: WorkspaceEditorPaneSymbol[] = [];
  for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
    const line = model.getLineContent(lineNumber);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      continue;
    }

    const patterns: Array<{
      detail?: (match: RegExpExecArray) => string | undefined;
      kind: string;
      nameIndex: number;
      pattern: RegExp;
    }> = [
      {
        kind: "function",
        nameIndex: 1,
        pattern: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/u,
      },
      {
        kind: "function",
        nameIndex: 1,
        pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u,
      },
      {
        kind: "function",
        nameIndex: 1,
        pattern:
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/u,
      },
      {
        kind: "function",
        nameIndex: 1,
        pattern:
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/u,
      },
      {
        kind: "function",
        nameIndex: 1,
        pattern: /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{:]/u,
      },
      { kind: "function", nameIndex: 1, pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u },
      {
        kind: "function",
        nameIndex: 1,
        pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/u,
      },
      { kind: "class", nameIndex: 1, pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/u },
      { kind: "class", nameIndex: 1, pattern: /^\s*class\s+([A-Za-z_]\w*)\b/u },
      {
        kind: "interface",
        nameIndex: 1,
        pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/u,
      },
      { kind: "type", nameIndex: 1, pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/u },
      { kind: "type", nameIndex: 1, pattern: /^\s*type\s+([A-Za-z_]\w*)\b/u },
      { kind: "struct", nameIndex: 1, pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)\b/u },
      { kind: "enum", nameIndex: 1, pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/u },
      { kind: "enum", nameIndex: 1, pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)\b/u },
      { kind: "trait", nameIndex: 1, pattern: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)\b/u },
      { kind: "impl", nameIndex: 1, pattern: /^\s*impl(?:<[^>]+>)?\s+([A-Za-z_][\w:]*)\b/u },
      {
        kind: "variable",
        nameIndex: 1,
        pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/u,
      },
      { kind: "variable", nameIndex: 1, pattern: /^\s*(?:const|var)\s+([A-Za-z_]\w*)\b/u },
    ];

    for (const entry of patterns) {
      const match = entry.pattern.exec(line);
      const name = match?.[entry.nameIndex];
      if (!match || !name) {
        continue;
      }
      const symbolInput: {
        detail?: string;
        kind: string;
        line: string;
        lineNumber: number;
        matchIndex: number;
        name: string;
      } = {
        kind: entry.kind,
        line,
        lineNumber,
        matchIndex: match.index + match[0].indexOf(name),
        name,
      };
      const detail = entry.detail?.(match);
      if (detail) {
        symbolInput.detail = detail;
      }
      symbols.push(createWorkspaceEditorPaneSymbol(symbolInput));
      break;
    }
  }
  return symbols;
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

function toMonacoCompletionItemKind(monacoInstance: MonacoApi, value: string | undefined) {
  if (!value) {
    return monacoInstance.languages.CompletionItemKind.Text;
  }
  const numericKind = Number.parseInt(value, 10);
  if (Number.isFinite(numericKind) && numericKind >= 0 && numericKind <= 30) {
    return numericKind;
  }
  return monacoInstance.languages.CompletionItemKind.Text;
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

function runEditorAction(
  editor: MonacoEditor.IStandaloneCodeEditor,
  actionId: string,
): void | Promise<void> {
  const action = editor.getAction(actionId);
  if (!action) {
    return;
  }
  return action.run();
}

function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
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
  const onProblemsChange = props.onProblemsChange;
  const onSymbolsChange = props.onSymbolsChange;
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [diagnosticSummary, setDiagnosticSummary] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [problems, setProblems] = useState<readonly MonacoEditor.IMarker[]>([]);
  const [cursorLabel, setCursorLabel] = useState("Ln 1, Col 1");
  const [activeSelection, setActiveSelection] = useState<ActiveSelectionState | null>(null);
  const [selectionActionsExpanded, setSelectionActionsExpanded] = useState(false);
  const [selectionCommentSubmitting, setSelectionCommentSubmitting] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [editorMountVersion, setEditorMountVersion] = useState(0);
  const [textPreviewFilePaths, setTextPreviewFilePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const syncRequestIdRef = useRef(0);
  const diagnosticsUnavailableRetryAtRef = useRef(0);
  const activePreviewKind = useMemo<WorkspacePreviewKind | null>(
    () => (pane.activeFilePath ? detectWorkspacePreviewKind(pane.activeFilePath) : null),
    [pane.activeFilePath],
  );
  const isBinaryPreviewMode = activePreviewKind === "image" || activePreviewKind === "video";
  const textPreviewAvailable = activePreviewKind === "markdown" || activePreviewKind === "mermaid";
  const isTextPreviewMode =
    textPreviewAvailable &&
    pane.activeFilePath !== null &&
    textPreviewFilePaths.has(pane.activeFilePath);
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
  const activeFileQuery = useQuery({
    ...projectReadFileQueryOptions({
      connectionUrl: props.connectionUrl,
      cwd: props.gitCwd,
      relativePath: pane.activeFilePath,
      enabled:
        pane.activeFilePath !== null &&
        props.gitCwd !== null &&
        (!isPreviewMode || isTextPreviewMode),
      refetchInterval: hasUnsavedBufferEdits ? false : WORKSPACE_FILE_REFETCH_INTERVAL_MS,
    }),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

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
  const activeFileCommentCount = useMemo(
    () => countOpenWorkspaceCodeComments(props.codeComments, props.pane.activeFilePath),
    [props.codeComments, props.pane.activeFilePath],
  );
  const activeModelPath = pane.activeFilePath
    ? createWorkspaceModelUriString(pane.activeFilePath)
    : undefined;
  const workspaceCwd = props.gitCwd ?? props.diagnosticsCwd;
  const [pendingNavigationTarget, setPendingNavigationTarget] =
    useState<WorkspaceEditorLocation | null>(null);
  const latestPaneStateRef = useRef({
    paneId: pane.id,
    activeFilePath: pane.activeFilePath,
  });
  const activeSelectionIdRef = useRef<string | null>(null);
  const onOpenFileInPaneRef = useRef(onOpenFileInPane);
  const draftsByFilePathRef = useRef(props.draftsByFilePath);

  useEffect(() => {
    latestPaneStateRef.current = {
      paneId: pane.id,
      activeFilePath: pane.activeFilePath,
    };
  }, [pane.activeFilePath, pane.id]);

  useEffect(() => {
    onOpenFileInPaneRef.current = onOpenFileInPane;
  }, [onOpenFileInPane]);

  useEffect(() => {
    draftsByFilePathRef.current = props.draftsByFilePath;
  }, [props.draftsByFilePath]);

  useEffect(() => {
    setTextPreviewFilePaths((current) => {
      if (current.size === 0) {
        return current;
      }
      const next = new Set(
        Array.from(current).filter((filePath) => props.pane.openFilePaths.includes(filePath)),
      );
      return next.size === current.size ? current : next;
    });
  }, [props.pane.openFilePaths]);

  const setActiveTextPreviewOpen = useCallback(
    (open: boolean) => {
      const activeFilePath = pane.activeFilePath;
      if (!activeFilePath || !textPreviewAvailable) {
        return;
      }
      setTextPreviewFilePaths((current) => {
        const next = new Set(current);
        if (open) {
          next.add(activeFilePath);
        } else {
          next.delete(activeFilePath);
        }
        if (
          next.size === current.size &&
          next.has(activeFilePath) === current.has(activeFilePath)
        ) {
          return current;
        }
        return next;
      });
    },
    [pane.activeFilePath, textPreviewAvailable],
  );

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
      onProblemsChange(pane.id, pane.activeFilePath, []);
      return;
    }
    const nextProblems = monacoInstance.editor.getModelMarkers({ resource: model.uri });
    setProblems(nextProblems);
    setDiagnosticSummary(formatProblemSummary(monacoInstance, nextProblems));
    onProblemsChange(pane.id, pane.activeFilePath, nextProblems.map(toWorkspaceEditorPaneProblem));
  }, [onProblemsChange, pane.activeFilePath, pane.id]);

  const syncSymbolState = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || isPreviewMode) {
      onSymbolsChange(pane.id, pane.activeFilePath, []);
      return;
    }
    onSymbolsChange(pane.id, pane.activeFilePath, extractWorkspaceEditorPaneSymbols(model));
  }, [isPreviewMode, onSymbolsChange, pane.activeFilePath, pane.id]);

  const syncEditorSelectionContext = useCallback(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monacoInstance || !model || !workspaceCwd || isPreviewMode) {
      setActiveSelection(null);
      setSelectionActionsExpanded(false);
      activeSelectionIdRef.current = null;
      return;
    }
    const position = editor.getPosition();
    if (position) {
      setCursorLabel(`Ln ${position.lineNumber}, Col ${position.column}`);
    }
    const selection = editor.getSelection();
    const relativePath = resolveRelativePathFromEditorModel(
      model,
      latestPaneStateRef.current.activeFilePath,
    );
    if (!selection || selection.isEmpty() || !relativePath) {
      setActiveSelection(null);
      setSelectionActionsExpanded(false);
      activeSelectionIdRef.current = null;
      return;
    }
    const text = model.getValueInRange(selection);
    if (text.trim().length === 0) {
      setActiveSelection(null);
      setSelectionActionsExpanded(false);
      activeSelectionIdRef.current = null;
      return;
    }
    const selectionId = workspaceSelectionId({ relativePath, selection });
    if (activeSelectionIdRef.current !== selectionId) {
      activeSelectionIdRef.current = selectionId;
      setSelectionActionsExpanded(false);
      setCommentDraft("");
    }
    const location = toWorkspaceLocationFromSelection(relativePath, selection);
    const visiblePosition = editor.getScrolledVisiblePosition({
      lineNumber: selection.getStartPosition().lineNumber,
      column: selection.getStartPosition().column,
    });
    const context = buildWorkspaceSelectionContext({
      cwd: workspaceCwd,
      diagnostics: problems.map((problem) => ({
        endColumn: Math.max(0, problem.endColumn - 1),
        endLine: Math.max(0, problem.endLineNumber - 1),
        message: problem.message,
        severity: toWorkspaceSeverity(monacoInstance, problem.severity),
        ...(problem.source ? { source: problem.source } : {}),
        startColumn: Math.max(0, problem.startColumn - 1),
        startLine: Math.max(0, problem.startLineNumber - 1),
      })),
      languageId: activeMonacoLanguage ?? null,
      range: location,
      text,
    });
    setActiveSelection({
      id: selectionId,
      context,
      left: Math.max(12, Math.min((visiblePosition?.left ?? 24) + 8, 360)),
      top: Math.max(12, (visiblePosition?.top ?? 24) + 28),
    });
  }, [activeMonacoLanguage, isPreviewMode, problems, workspaceCwd]);

  const activeFileReady =
    pane.activeFilePath !== null &&
    (isPreviewMode || activeDraft !== null || activeFileQuery.data?.contents !== undefined);

  const ensureWorkspaceModelLoaded = useCallback(
    async (relativePath: string): Promise<MonacoEditor.ITextModel | null> => {
      const monacoInstance = monacoRef.current;
      if (!api || !monacoInstance || !workspaceCwd) {
        return null;
      }
      const uri = createWorkspaceModelUri(monacoInstance, relativePath);
      const existingModel = monacoInstance.editor.getModel(uri);
      if (existingModel) {
        return existingModel;
      }

      const draft = draftsByFilePathRef.current[relativePath];
      let contents = draft?.draftContents;
      if (contents === undefined) {
        const result = await api.projects.readFile(
          withRpcRouteConnection(
            {
              cwd: workspaceCwd,
              relativePath,
            },
            props.connectionUrl,
          ),
        );
        contents = result.contents;
        onHydrateFile(relativePath, result.contents);
      }

      const reusedModel = monacoInstance.editor.getModel(uri);
      if (reusedModel) {
        return reusedModel;
      }
      return monacoInstance.editor.createModel(
        contents,
        resolveMonacoLanguageFromFilePath(relativePath),
        uri,
      );
    },
    [api, onHydrateFile, props.connectionUrl, workspaceCwd],
  );

  const toMonacoLocations = useCallback(
    async (locations: readonly WorkspaceEditorLocation[]) => {
      const resolvedLocations = await Promise.all(
        locations.map(async (location) => {
          const model = await ensureWorkspaceModelLoaded(location.relativePath);
          if (!model) {
            return null;
          }
          return {
            uri: model.uri,
            range: toMonacoRangeFromWorkspaceLocation(location),
          };
        }),
      );
      return resolvedLocations.filter(
        (
          location,
        ): location is {
          uri: MonacoEditor.ITextModel["uri"];
          range: ReturnType<typeof toMonacoRangeFromWorkspaceLocation>;
        } => location !== null,
      );
    },
    [ensureWorkspaceModelLoaded],
  );

  const focusWorkspaceLocation = useCallback((location: WorkspaceEditorLocation) => {
    const editor = editorRef.current;
    const latestPaneState = latestPaneStateRef.current;
    if (!editor) {
      return;
    }
    if (location.relativePath === latestPaneState.activeFilePath) {
      const range = toMonacoRangeFromWorkspaceLocation(location);
      editor.focus();
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      return;
    }
    setPendingNavigationTarget(location);
    onOpenFileInPaneRef.current(latestPaneState.paneId, location.relativePath);
  }, []);

  const loadDefinitionLocations = useCallback(
    async (input: {
      relativePath: string;
      contents: string;
      line: number;
      column: number;
    }): Promise<readonly WorkspaceEditorLocation[]> => {
      if (!api || !props.diagnosticsCwd) {
        return [];
      }
      try {
        setActionError(null);
        const result = await api.workspaceEditor.definition(
          withRpcRouteConnection(
            {
              cwd: props.diagnosticsCwd,
              relativePath: input.relativePath,
              contents: input.contents,
              line: input.line,
              column: input.column,
            },
            props.connectionUrl,
          ),
        );
        return result.locations;
      } catch (error) {
        const message = toErrorMessage(error);
        setActionError(message);
        console.error("Failed to resolve workspace editor definitions", {
          diagnosticsCwd: props.diagnosticsCwd,
          relativePath: input.relativePath,
          error,
        });
        return [];
      }
    },
    [api, props.connectionUrl, props.diagnosticsCwd],
  );

  const navigateToDefinitionAtPosition = useCallback(
    async (position: { lineNumber: number; column: number }) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model || isPreviewMode) {
        return;
      }
      const relativePath = resolveRelativePathFromEditorModel(
        model,
        latestPaneStateRef.current.activeFilePath,
      );
      if (!relativePath) {
        return;
      }
      const locations = await loadDefinitionLocations({
        relativePath,
        contents: model.getValue(),
        line: Math.max(0, position.lineNumber - 1),
        column: Math.max(0, position.column - 1),
      });
      const firstLocation = locations[0];
      if (!firstLocation) {
        return;
      }
      focusWorkspaceLocation(firstLocation);
    },
    [focusWorkspaceLocation, isPreviewMode, loadDefinitionLocations],
  );

  const handleEditorMount = useCallback<OnMount>(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      monacoRef.current = monacoInstance;
      setEditorMountVersion((version) => version + 1);
      editor.onDidFocusEditorWidget(() => {
        onFocusPane(pane.id);
      });
      editor.onMouseDown((event) => {
        if (
          !event.target.position ||
          event.target.type !== monacoInstance.editor.MouseTargetType.CONTENT_TEXT ||
          !(event.event.metaKey || event.event.ctrlKey) ||
          !event.event.leftButton
        ) {
          return;
        }
        event.event.preventDefault();
        event.event.stopPropagation();
        void navigateToDefinitionAtPosition(event.target.position);
      });
      editor.onDidChangeModel(() => {
        const model = editor.getModel();
        const nextRelativePath = model ? readRelativePathFromWorkspaceModelUri(model.uri) : null;
        if (!nextRelativePath) {
          return;
        }
        const latestPaneState = latestPaneStateRef.current;
        if (nextRelativePath === latestPaneState.activeFilePath) {
          return;
        }
        const selection = editor.getSelection();
        if (selection) {
          setPendingNavigationTarget(toWorkspaceLocationFromSelection(nextRelativePath, selection));
        }
        onOpenFileInPaneRef.current(latestPaneState.paneId, nextRelativePath);
      });
      editor.onDidChangeCursorPosition(() => {
        const position = editor.getPosition();
        if (position) {
          setCursorLabel(`Ln ${position.lineNumber}, Col ${position.column}`);
        }
      });
      editor.onDidChangeCursorSelection(() => {
        window.setTimeout(syncEditorSelectionContext, 0);
      });
      editor.onDidChangeModelContent(() => {
        syncSymbolState();
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        saveActionRef.current();
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Space, () => {
        void runEditorAction(editor, "editor.action.triggerSuggest");
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyI, () => {
        void runEditorAction(editor, "editor.action.triggerParameterHints");
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyF, () => {
        void runEditorAction(editor, "actions.find");
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyH, () => {
        void runEditorAction(editor, "editor.action.startFindReplaceAction");
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyG, () => {
        void runEditorAction(editor, "editor.action.gotoLine");
      });
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyO,
        () => {
          void runEditorAction(editor, "workbench.action.gotoSymbol");
        },
      );
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyD, () => {
        void runEditorAction(editor, "editor.action.addSelectionToNextFindMatch");
      });
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyL,
        () => {
          void runEditorAction(editor, "editor.action.selectHighlights");
        },
      );
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd |
          monacoInstance.KeyMod.Alt |
          monacoInstance.KeyCode.DownArrow,
        () => {
          void runEditorAction(editor, "editor.action.insertCursorBelow");
        },
      );
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.UpArrow,
        () => {
          void runEditorAction(editor, "editor.action.insertCursorAbove");
        },
      );
      editor.addCommand(
        monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.KeyI,
        () => {
          void runEditorAction(editor, "editor.action.insertCursorAtEndOfEachLineSelected");
        },
      );
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyU, () => {
        void runEditorAction(editor, "cursorUndo");
      });
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyK,
        () => {
          void runEditorAction(editor, "editor.action.deleteLines");
        },
      );
      editor.addCommand(
        monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.DownArrow,
        () => {
          void runEditorAction(editor, "editor.action.copyLinesDownAction");
        },
      );
      editor.addCommand(
        monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.UpArrow,
        () => {
          void runEditorAction(editor, "editor.action.copyLinesUpAction");
        },
      );
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.BracketRight, () => {
        void runEditorAction(editor, "editor.action.indentLines");
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.BracketLeft, () => {
        void runEditorAction(editor, "editor.action.outdentLines");
      });
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd |
          monacoInstance.KeyMod.Shift |
          monacoInstance.KeyCode.Backslash,
        () => {
          void runEditorAction(editor, "editor.action.jumpToBracket");
        },
      );
      editor.addCommand(monacoInstance.KeyCode.F12, () => {
        const position = editor.getPosition();
        if (!position) {
          return;
        }
        void navigateToDefinitionAtPosition(position);
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
      syncSymbolState();
      syncEditorSelectionContext();
    },
    [
      navigateToDefinitionAtPosition,
      onFocusPane,
      pane.id,
      syncEditorSelectionContext,
      syncProblemState,
      syncSymbolState,
    ],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (
      !editor ||
      !pendingNavigationTarget ||
      pane.activeFilePath !== pendingNavigationTarget.relativePath
    ) {
      return;
    }
    const range = toMonacoRangeFromWorkspaceLocation(pendingNavigationTarget);
    editor.focus();
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    setPendingNavigationTarget(null);
  }, [editorMountVersion, pane.activeFilePath, pendingNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    const target = props.problemNavigationTarget;
    if (!editor || !target || pane.activeFilePath !== target.location.relativePath) {
      return;
    }
    const range = toMonacoRangeFromWorkspaceLocation(target.location);
    editor.focus();
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
  }, [editorMountVersion, pane.activeFilePath, props.problemNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    const target = props.symbolNavigationTarget;
    if (!editor || !target || pane.activeFilePath !== target.location.relativePath) {
      return;
    }
    const range = toMonacoRangeFromWorkspaceLocation(target.location);
    editor.focus();
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
  }, [editorMountVersion, pane.activeFilePath, props.symbolNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.active || !props.findRequestToken) {
      return;
    }
    editor.focus();
    void runEditorAction(editor, "actions.find");
  }, [editorMountVersion, props.active, props.findRequestToken]);

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

    if (Date.now() < diagnosticsUnavailableRetryAtRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void api.workspaceEditor
        .syncBuffer(
          withRpcRouteConnection(
            {
              cwd: props.diagnosticsCwd!,
              relativePath: activeFilePath,
              contents: activeFileContents,
            },
            props.connectionUrl,
          ),
        )
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
          diagnosticsUnavailableRetryAtRef.current = 0;
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
            diagnosticsUnavailableRetryAtRef.current = Date.now() + DIAGNOSTIC_UNAVAILABLE_RETRY_MS;
            setDiagnosticError(toErrorMessage(error));
          } else {
            const message = toErrorMessage(error);
            setDiagnosticError(message);
          }
          syncProblemState();
          console.error("Failed to sync workspace editor diagnostics", {
            cwd: props.gitCwd,
            diagnosticsCwd: props.diagnosticsCwd,
            relativePath: activeFilePath,
            error,
          });
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
    props.connectionUrl,
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

  useEffect(() => {
    syncEditorSelectionContext();
  }, [pane.activeFilePath, problems, syncEditorSelectionContext]);

  useEffect(() => {
    syncSymbolState();
  }, [activeFileContents, editorMountVersion, pane.activeFilePath, syncSymbolState]);

  useEffect(() => {
    const monacoInstance = monacoRef.current;
    if (!api || !monacoInstance || !activeMonacoLanguage) {
      return;
    }
    const provider = monacoInstance.languages.registerCompletionItemProvider(activeMonacoLanguage, {
      triggerCharacters: [...COMPLETION_TRIGGER_CHARACTERS],
      provideCompletionItems: async (model, position, _context, _token) => {
        if (!props.diagnosticsCwd || !pane.activeFilePath || isPreviewMode) {
          return { suggestions: [] };
        }
        try {
          const result = await api.workspaceEditor.complete(
            withRpcRouteConnection(
              {
                cwd: props.diagnosticsCwd,
                relativePath: pane.activeFilePath,
                contents: model.getValue(),
                line: Math.max(0, position.lineNumber - 1),
                column: Math.max(0, position.column - 1),
              },
              props.connectionUrl,
            ),
          );
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            suggestions: result.items.map((item) => {
              const suggestion: {
                label: string;
                kind: number;
                insertText: string;
                range: {
                  startLineNumber: number;
                  endLineNumber: number;
                  startColumn: number;
                  endColumn: number;
                };
                detail?: string;
                documentation?: string;
                sortText?: string;
                filterText?: string;
              } = {
                label: item.label,
                kind: toMonacoCompletionItemKind(monacoInstance, item.kind),
                insertText: item.insertText ?? item.label,
                range,
              };
              if (item.detail) {
                suggestion.detail = item.detail;
              }
              if (item.documentation) {
                suggestion.documentation = item.documentation;
              }
              if (item.sortText) {
                suggestion.sortText = item.sortText;
              }
              if (item.filterText) {
                suggestion.filterText = item.filterText;
              }
              return suggestion;
            }),
          };
        } catch {
          return { suggestions: [] };
        }
      },
    });
    return () => {
      provider.dispose();
    };
  }, [
    activeMonacoLanguage,
    api,
    editorMountVersion,
    isPreviewMode,
    pane.activeFilePath,
    props.connectionUrl,
    props.diagnosticsCwd,
  ]);

  useEffect(() => {
    const monacoInstance = monacoRef.current;
    if (!api || !monacoInstance || !activeMonacoLanguage) {
      return;
    }
    const provider = monacoInstance.languages.registerDefinitionProvider(activeMonacoLanguage, {
      provideDefinition: async (model, position, token) => {
        const relativePath = resolveRelativePathFromEditorModel(model, pane.activeFilePath);
        if (!relativePath || isPreviewMode) {
          return null;
        }
        const locations = await loadDefinitionLocations({
          relativePath,
          contents: model.getValue(),
          line: Math.max(0, position.lineNumber - 1),
          column: Math.max(0, position.column - 1),
        });
        if (token.isCancellationRequested) {
          return null;
        }
        const monacoLocations = await toMonacoLocations(locations);
        return monacoLocations.length > 0 ? monacoLocations : null;
      },
    });
    return () => {
      provider.dispose();
    };
  }, [
    activeMonacoLanguage,
    api,
    editorMountVersion,
    isPreviewMode,
    loadDefinitionLocations,
    pane.activeFilePath,
    props.diagnosticsCwd,
    toMonacoLocations,
  ]);

  useEffect(() => {
    const monacoInstance = monacoRef.current;
    if (!api || !monacoInstance || !activeMonacoLanguage) {
      return;
    }
    const provider = monacoInstance.languages.registerReferenceProvider(activeMonacoLanguage, {
      provideReferences: async (model, position, context, token) => {
        const relativePath = resolveRelativePathFromEditorModel(model, pane.activeFilePath);
        if (!props.diagnosticsCwd || !relativePath || isPreviewMode) {
          return [];
        }
        try {
          const result = await api.workspaceEditor.references(
            withRpcRouteConnection(
              {
                cwd: props.diagnosticsCwd,
                relativePath,
                contents: model.getValue(),
                line: Math.max(0, position.lineNumber - 1),
                column: Math.max(0, position.column - 1),
              },
              props.connectionUrl,
            ),
          );
          if (token.isCancellationRequested) {
            return [];
          }
          const filteredLocations = context.includeDeclaration
            ? result.locations
            : result.locations.filter((location) => location.relativePath !== relativePath);
          return toMonacoLocations(filteredLocations);
        } catch {
          return [];
        }
      },
    });
    return () => {
      provider.dispose();
    };
  }, [
    activeMonacoLanguage,
    api,
    editorMountVersion,
    isPreviewMode,
    pane.activeFilePath,
    props.connectionUrl,
    props.diagnosticsCwd,
    toMonacoLocations,
  ]);

  useEffect(
    () => () => {
      syncRequestIdRef.current += 1;
      clearEditorMarkers();
    },
    [clearEditorMarkers],
  );

  const readDraggedTab = useCallback((event: ReactDragEvent<HTMLElement>) => {
    return readEditorTabTransfer(event.dataTransfer);
  }, []);
  const readDraggedExplorerEntry = useCallback((event: ReactDragEvent<HTMLElement>) => {
    return readExplorerEntryTransfer(event.dataTransfer);
  }, []);
  const autoScrollTabStripOnDragOver = useCallback((clientX: number) => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      return;
    }
    const bounds = tabStrip.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const edgeThreshold = Math.min(72, bounds.width / 3);
    const maxStep = 20;
    if (clientX < bounds.left + edgeThreshold) {
      const intensity = (bounds.left + edgeThreshold - clientX) / edgeThreshold;
      tabStrip.scrollLeft -= Math.ceil(maxStep * Math.min(1, intensity));
      return;
    }
    if (clientX > bounds.right - edgeThreshold) {
      const intensity = (clientX - (bounds.right - edgeThreshold)) / edgeThreshold;
      tabStrip.scrollLeft += Math.ceil(maxStep * Math.min(1, intensity));
    }
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
        autoScrollTabStripOnDragOver(event.clientX);
        setDropTargetIndex(targetIndex ?? pane.openFilePaths.length);
        return;
      }
      const draggedEntry = readDraggedExplorerEntry(event);
      if (!draggedEntry || draggedEntry.kind !== "file") {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      autoScrollTabStripOnDragOver(event.clientX);
      setDropTargetIndex(targetIndex ?? pane.openFilePaths.length);
    },
    [
      autoScrollTabStripOnDragOver,
      pane.openFilePaths.length,
      readDraggedExplorerEntry,
      readDraggedTab,
    ],
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

  const handleAddAndSendSelectionComment = useCallback(async () => {
    if (
      !activeSelection ||
      !workspaceCwd ||
      commentDraft.trim().length === 0 ||
      !props.onAddCodeCommentAndSend ||
      selectionCommentSubmitting
    ) {
      return;
    }
    setSelectionCommentSubmitting(true);
    let sent = false;
    try {
      sent = await props.onAddCodeCommentAndSend(
        createWorkspaceCodeComment({
          body: commentDraft,
          code: activeSelection.context.text,
          createdAt: new Date().toISOString(),
          cwd: workspaceCwd,
          id:
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `comment-${Date.now().toString(36)}`,
          range: activeSelection.context.range,
        }),
      );
    } catch {
      sent = false;
    } finally {
      setSelectionCommentSubmitting(false);
    }
    if (!sent) {
      return;
    }
    setCommentDraft("");
    setSelectionActionsExpanded(false);
  }, [activeSelection, commentDraft, props, selectionCommentSubmitting, workspaceCwd]);

  useEffect(() => {
    setActionError(null);
    setPreviewError(null);
    setProblemsOpen(false);
  }, [pane.activeFilePath]);

  const activeFileErrorMessage =
    activeFileQuery.error instanceof Error
      ? activeFileQuery.error.message
      : "An unexpected error occurred.";
  return (
    <section
      data-pane-active={props.active ? "true" : "false"}
      className={cn(
        "group relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-0 bg-transparent transition-colors",
      )}
      onPointerDown={() => {
        props.onFocusPane(props.pane.id);
      }}
    >
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border bg-card/78 px-1.5",
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
        <div
          ref={tabStripRef}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {props.pane.openFilePaths.map((filePath) => {
            const isActive = filePath === props.pane.activeFilePath;
            const isDirty = props.dirtyFilePaths.has(filePath);
            return (
              <div key={filePath} className="relative flex shrink-0">
                {dropTargetIndex === props.pane.openFilePaths.indexOf(filePath) ? (
                  <div className="absolute top-1.5 bottom-1.5 left-0 z-20 w-[2px] rounded-full bg-primary/85" />
                ) : null}
                <button
                  type="button"
                  data-editor-tab="true"
                  className={cn(
                    "group/tab relative flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors",
                    isActive
                      ? "border-border/70 bg-background text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground",
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
                  <VscodeEntryIcon
                    pathValue={filePath}
                    kind="file"
                    theme={props.resolvedTheme}
                    className="size-[14px] shrink-0"
                  />
                  <span className="max-w-[150px] truncate font-medium">
                    {basenameOfPath(filePath)}
                  </span>
                  {isDirty ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground/45 group-hover/tab:hidden" />
                  ) : null}
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity",
                      isActive ? "opacity-100" : "group-hover/tab:opacity-100",
                      "hover:bg-background/70",
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
        <div className={cn("flex shrink-0 items-center gap-0.5 border-l px-1", "border-border/70")}>
          {props.chromeActions ? (
            <div className="mr-1 flex shrink-0 items-center gap-0.5">{props.chromeActions}</div>
          ) : null}
          {textPreviewAvailable && props.gitCwd !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground",
                      isTextPreviewMode && "bg-accent text-foreground hover:text-foreground",
                    )}
                    onClick={() => setActiveTextPreviewOpen(!isTextPreviewMode)}
                    aria-pressed={isTextPreviewMode}
                    aria-label={isTextPreviewMode ? "Open editor" : "Open preview"}
                  >
                    {isTextPreviewMode ? (
                      <PencilIcon className="size-3.5" />
                    ) : (
                      <EyeIcon className="size-3.5" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                {isTextPreviewMode ? "Open editor" : previewModeLabel}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={() => props.onSplitPane(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Right"
          >
            <Columns2Icon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={() => props.onSplitPaneDown(props.pane.id)}
            disabled={!props.canSplitPane}
            title="Split Editor Down"
          >
            <Rows2Icon className="size-3.5" />
          </Button>
          {props.canClosePane ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={() => props.onClosePane(props.pane.id)}
              title="Close Editor Group"
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cn("relative min-h-0 min-w-0 flex-1", "bg-background")}>
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
              <div
                className={cn(
                  "flex h-full min-h-[220px] items-center justify-center border",
                  "border-border/60 bg-card/72",
                )}
              >
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
            <div
              className={cn(
                "flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground",
                "border-border/60",
              )}
            >
              <span className="truncate">{previewModeLabel}</span>
            </div>
          </div>
        ) : isTextPreviewMode && activeFileQuery.data?.contents !== undefined ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <div className={cn("min-h-[220px] border p-4", "border-border/60 bg-card/72")}>
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
            <div
              className={cn(
                "flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground",
                "border-border/60",
              )}
            >
              <span className="truncate">{previewModeLabel}</span>
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
            <div className="max-w-md rounded-xl bg-destructive/5 p-4 text-center">
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
              </div>
            </div>
          </div>
        ) : (
          <div className="relative h-full min-h-0 min-w-0 overflow-hidden">
            <Editor
              height="100%"
              value={activeFileContents}
              theme={props.monacoTheme}
              onMount={handleEditorMount}
              onChange={(value) => {
                if (!props.pane.activeFilePath || value === undefined) {
                  return;
                }
                props.onUpdateDraft(props.pane.activeFilePath, value);
              }}
              options={props.editorOptions}
              {...(activeModelPath ? { path: activeModelPath } : {})}
              {...(activeMonacoLanguage ? { language: activeMonacoLanguage } : {})}
            />
            {activeSelection ? (
              <div
                className="absolute z-20"
                style={{
                  left: activeSelection.left,
                  top: activeSelection.top,
                }}
              >
                {!selectionActionsExpanded ? (
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-full border border-border/70 bg-background/92 text-muted-foreground/75 shadow-sm backdrop-blur hover:bg-accent hover:text-foreground"
                    onClick={() => setSelectionActionsExpanded((current) => !current)}
                    aria-label="Open selection actions"
                    title="Selection actions"
                  >
                    <SparklesIcon className="size-3 text-primary/85" />
                  </button>
                ) : (
                  <form
                    className="flex h-12 w-[min(380px,calc(100vw-20px))] items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 shadow-[0_16px_38px_rgba(0,0,0,0.18)] backdrop-blur-xl"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleAddAndSendSelectionComment();
                    }}
                  >
                    <input
                      value={commentDraft}
                      onChange={(event) => setCommentDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setSelectionActionsExpanded(false);
                        }
                      }}
                      placeholder="Comment for the agent"
                      className="h-9 min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] font-medium outline-none placeholder:text-muted-foreground/55"
                      autoFocus
                    />
                    {props.onAddCodeCommentAndSend ? (
                      <button
                        type="submit"
                        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                        disabled={commentDraft.trim().length === 0 || selectionCommentSubmitting}
                        aria-label="Submit comment"
                        title="Submit comment"
                      >
                        <ArrowUpRightIcon className="size-4" />
                      </button>
                    ) : null}
                  </form>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!isPreviewMode && problemsOpen ? (
        <section className={cn("shrink-0 border-t", "border-border bg-card/72")}>
          <header
            className={cn(
              "flex h-8 items-center justify-between border-b bg-transparent px-3 text-[11px] text-muted-foreground",
              "border-border/70",
            )}
          >
            <span className="font-medium tracking-[0.08em] uppercase">Problems</span>
            <span className="px-1.5 py-px text-[10px] text-foreground/75">
              {sortedProblems.length}
            </span>
          </header>
          <div className="max-h-44 overflow-y-auto">
            {sortedProblems.length > 0 ? (
              <div className="py-1">
                {sortedProblems.map((problem) => {
                  const severity = severityFromMarkerValue(problem.severity);
                  return (
                    <button
                      key={`${problem.owner}:${problem.startLineNumber}:${problem.startColumn}:${problem.message}`}
                      type="button"
                      className="mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] hover:bg-accent"
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

      <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-card/80 px-2.5 text-[10.5px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
          {props.pane.activeFilePath ? (
            <>
              <span className="truncate font-medium text-foreground/78">
                {props.pane.activeFilePath}
              </span>
              {activeFileSizeBytes !== null ? (
                <span className="shrink-0 rounded-md bg-foreground/6 px-1.5 py-px text-foreground/72">
                  {formatFileSize(activeFileSizeBytes)}
                </span>
              ) : null}
              {activeFileDirty ? (
                <span className="shrink-0 rounded-md bg-amber-500/12 px-1.5 py-px text-[9px] font-semibold tracking-[0.12em] text-amber-600 uppercase">
                  Modified
                </span>
              ) : null}
              {activeFileCommentCount > 0 ? (
                <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-px text-[9px] font-semibold tracking-[0.12em] text-primary uppercase">
                  {activeFileCommentCount} comments
                </span>
              ) : null}
            </>
          ) : (
            <span className="rounded-md bg-foreground/6 px-1.5 py-px text-foreground/72">
              Ready
            </span>
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
            <span className="rounded-md bg-foreground/5 px-1.5 py-px text-foreground/65">
              {cursorLabel}
            </span>
          ) : null}
          {activeMonacoLanguage && !isPreviewMode ? (
            <span className="rounded-md bg-foreground/5 px-1.5 py-px text-foreground/65">
              {activeMonacoLanguage}
            </span>
          ) : null}
          {props.pane.activeFilePath && !isPreviewMode ? (
            <button
              type="button"
              className="rounded-md px-1.5 py-px text-foreground/75 transition-[background-color,color] hover:bg-accent hover:text-foreground"
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
              className="rounded-md px-1.5 py-px text-foreground/72 transition-[background-color,color] hover:bg-accent hover:text-foreground"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
            >
              Revert
            </button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <button
              type="button"
              className="rounded-md bg-foreground/10 px-1.5 py-px font-medium text-foreground transition-colors hover:bg-foreground/14"
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

const MemoizedWorkspaceEditorPane = memo(WorkspaceEditorPane);
MemoizedWorkspaceEditorPane.displayName = "WorkspaceEditorPane";

export default MemoizedWorkspaceEditorPane;
