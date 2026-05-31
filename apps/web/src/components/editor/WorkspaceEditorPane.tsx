import type {
  WorkspaceEditorCompletionItem,
  WorkspaceEditorDiagnostic,
  WorkspaceEditorLocation,
} from "@ace/contracts";
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
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type { ThreadEditorPaneState } from "~/editorStateStore";
import { withRpcRouteConnection } from "~/lib/connectionRouting";
import {
  WORKSPACE_CODE_EDITOR_PROBLEM_OWNER,
  workspaceSeverityFromValue,
  workspaceSeverityValue,
  type WorkspaceCodeEditorProblem,
} from "~/lib/editor/workspaceCodeMirror";
import type { WorkspaceCodeEditorOptions } from "~/lib/editor/workspaceEditorOptions";
import { resolveWorkspaceLanguageFromFilePath } from "~/lib/editor/workspaceLanguageMapping";
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
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  EDITOR_TAB_TRANSFER_TYPE,
  readEditorTabTransfer,
  readExplorerEntryTransfer,
} from "./dragTransfer";
import WorkspaceCodeEditor, {
  type WorkspaceCodeEditorHandle,
  type WorkspaceCodeEditorSelection,
} from "./WorkspaceCodeEditor";
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
  editorOptions: WorkspaceCodeEditorOptions;
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
  pane: ThreadEditorPaneState;
  paneIndex: number;
  resolvedTheme: "light" | "dark";
  savingFilePath: string | null;
  problemNavigationTarget: WorkspaceEditorProblemNavigationTarget | null;
  symbolNavigationTarget: WorkspaceEditorSymbolNavigationTarget | null;
  findRequestToken?: number;
}

export type WorkspaceEditorPaneProblem = WorkspaceCodeEditorProblem;

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

interface ActiveSelectionState {
  readonly id: string;
  readonly context: WorkspaceSelectionContext;
  readonly top: number;
  readonly left: number;
}

type WorkspaceEditorFeedbackState = {
  actionError: string | null;
  diagnosticSummary: string | null;
  diagnosticError: string | null;
  diagnostics: readonly WorkspaceEditorDiagnostic[];
  previewError: string | null;
  problemsOpen: boolean;
  problems: readonly WorkspaceEditorPaneProblem[];
};

const EMPTY_WORKSPACE_EDITOR_FEEDBACK_STATE: WorkspaceEditorFeedbackState = {
  actionError: null,
  diagnosticSummary: null,
  diagnosticError: null,
  diagnostics: [],
  previewError: null,
  problemsOpen: false,
  problems: [],
};

type WorkspaceEditorNavigationState = {
  editorMountVersion: number;
  pendingNavigationTarget: WorkspaceEditorLocation | null;
};

type WorkspaceEditorNavigationAction =
  | { type: "editor-mounted" }
  | { type: "set-pending-navigation-target"; location: WorkspaceEditorLocation }
  | { type: "clear-pending-navigation-target" };

const EMPTY_WORKSPACE_EDITOR_NAVIGATION_STATE: WorkspaceEditorNavigationState = {
  editorMountVersion: 0,
  pendingNavigationTarget: null,
};

function workspaceEditorNavigationStateReducer(
  state: WorkspaceEditorNavigationState,
  action: WorkspaceEditorNavigationAction,
): WorkspaceEditorNavigationState {
  switch (action.type) {
    case "editor-mounted":
      return {
        ...state,
        editorMountVersion: state.editorMountVersion + 1,
      };
    case "set-pending-navigation-target":
      return {
        ...state,
        pendingNavigationTarget: action.location,
      };
    case "clear-pending-navigation-target":
      return state.pendingNavigationTarget === null
        ? state
        : {
            ...state,
            pendingNavigationTarget: null,
          };
  }
}

type WorkspaceEditorSelectionState = {
  cursorLabel: string;
  activeSelection: ActiveSelectionState | null;
  selectionActionsExpanded: boolean;
  selectionCommentSubmitting: boolean;
  commentDraft: string;
};

type WorkspaceEditorSelectionAction =
  | { type: "set-cursor-label"; cursorLabel: string }
  | { type: "set-active-selection"; activeSelection: ActiveSelectionState | null }
  | { type: "set-selection-actions-expanded"; selectionActionsExpanded: boolean }
  | { type: "set-selection-comment-submitting"; selectionCommentSubmitting: boolean }
  | { type: "set-comment-draft"; commentDraft: string }
  | { type: "clear-selection" }
  | { type: "reset-selection-comment" };

const EMPTY_WORKSPACE_EDITOR_SELECTION_STATE: WorkspaceEditorSelectionState = {
  cursorLabel: "Ln 1, Col 1",
  activeSelection: null,
  selectionActionsExpanded: false,
  selectionCommentSubmitting: false,
  commentDraft: "",
};

function workspaceEditorSelectionStateReducer(
  state: WorkspaceEditorSelectionState,
  action: WorkspaceEditorSelectionAction,
): WorkspaceEditorSelectionState {
  switch (action.type) {
    case "set-cursor-label":
      return state.cursorLabel === action.cursorLabel
        ? state
        : { ...state, cursorLabel: action.cursorLabel };
    case "set-active-selection":
      return state.activeSelection === action.activeSelection
        ? state
        : { ...state, activeSelection: action.activeSelection };
    case "set-selection-actions-expanded":
      return state.selectionActionsExpanded === action.selectionActionsExpanded
        ? state
        : { ...state, selectionActionsExpanded: action.selectionActionsExpanded };
    case "set-selection-comment-submitting":
      return state.selectionCommentSubmitting === action.selectionCommentSubmitting
        ? state
        : { ...state, selectionCommentSubmitting: action.selectionCommentSubmitting };
    case "set-comment-draft":
      return state.commentDraft === action.commentDraft
        ? state
        : { ...state, commentDraft: action.commentDraft };
    case "clear-selection":
      return state.activeSelection === null &&
        state.selectionActionsExpanded === false &&
        state.selectionCommentSubmitting === false &&
        state.commentDraft === ""
        ? state
        : {
            ...state,
            activeSelection: null,
            selectionActionsExpanded: false,
            selectionCommentSubmitting: false,
            commentDraft: "",
          };
    case "reset-selection-comment":
      return state.selectionActionsExpanded === false &&
        state.selectionCommentSubmitting === false &&
        state.commentDraft === ""
        ? state
        : {
            ...state,
            selectionActionsExpanded: false,
            selectionCommentSubmitting: false,
            commentDraft: "",
          };
  }
}

const DIAGNOSTIC_SYNC_DEBOUNCE_MS = 250;
const DIAGNOSTIC_UNAVAILABLE_RETRY_MS = 3_000;
const WORKSPACE_FILE_REFETCH_INTERVAL_MS = 5_000;

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 KB";
  }
  if (sizeBytes < 1024) {
    return "<1 KB";
  }
  return `${Math.round(sizeBytes / 1024)} KB`;
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

function formatProblemSummary(markers: readonly WorkspaceEditorPaneProblem[]): string | null {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let hintCount = 0;

  for (const marker of markers) {
    switch (workspaceSeverityFromValue(marker.severity)) {
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

function toWorkspaceEditorPaneProblem(
  diagnostic: WorkspaceEditorDiagnostic,
): WorkspaceEditorPaneProblem {
  const startLineNumber = diagnostic.startLine + 1;
  const startColumn = diagnostic.startColumn + 1;
  const endLineNumber = diagnostic.endLine + 1;
  const endColumn =
    diagnostic.endLine === diagnostic.startLine
      ? Math.max(startColumn + 1, diagnostic.endColumn + 1)
      : Math.max(1, diagnostic.endColumn + 1);

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
    endColumn,
    endLineNumber,
    message: diagnostic.message.trim().length > 0 ? diagnostic.message : "Language diagnostic",
    owner: WORKSPACE_CODE_EDITOR_PROBLEM_OWNER,
    severity: workspaceSeverityValue(diagnostic.severity),
    startColumn,
    startLineNumber,
  };

  if (diagnostic.code !== undefined) {
    problem.code = diagnostic.code;
  }
  if (diagnostic.source !== undefined) {
    problem.source = diagnostic.source;
  }
  return problem;
}

function toWorkspaceLocationFromProblem(
  relativePath: string,
  problem: WorkspaceEditorPaneProblem,
): WorkspaceEditorLocation {
  return {
    endColumn: Math.max(0, problem.endColumn - 1),
    endLine: Math.max(0, problem.endLineNumber - 1),
    relativePath,
    startColumn: Math.max(0, problem.startColumn - 1),
    startLine: Math.max(0, problem.startLineNumber - 1),
  };
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

type WorkspaceEditorPaneSymbolPattern = {
  detail?: (
    match: RegExpExecArray & { indices?: Array<[number, number] | undefined> },
  ) => string | undefined;
  kind: string;
  nameIndex: number;
  pattern: RegExp;
};

const workspaceEditorPaneSymbolPatternBase: WorkspaceEditorPaneSymbolPattern[] = [
  { kind: "function", nameIndex: 1, pattern: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/u },
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

const workspaceEditorPaneSymbolPatterns = workspaceEditorPaneSymbolPatternBase.map((entry) => {
  const pattern: WorkspaceEditorPaneSymbolPattern = {
    kind: entry.kind,
    nameIndex: entry.nameIndex,
    pattern: new RegExp(entry.pattern.source, `${entry.pattern.flags}d`),
  };
  if (entry.detail) {
    pattern.detail = entry.detail;
  }
  return pattern;
});

function extractWorkspaceEditorPaneSymbols(contents: string): WorkspaceEditorPaneSymbol[] {
  const symbols: WorkspaceEditorPaneSymbol[] = [];
  const lines = contents.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      continue;
    }

    for (const entry of workspaceEditorPaneSymbolPatterns) {
      const match = entry.pattern.exec(line) as
        | (RegExpExecArray & {
            indices?: Array<[number, number] | undefined>;
          })
        | null;
      const name = match?.[entry.nameIndex];
      if (!match || !name) {
        continue;
      }
      const matchIndex = match.indices?.[entry.nameIndex]?.[0];
      if (matchIndex === undefined) {
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
        lineNumber: lineIndex + 1,
        matchIndex,
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

function diagnosticsForSelectionContext(
  problems: readonly WorkspaceEditorPaneProblem[],
): WorkspaceSelectionContext["diagnostics"] {
  return problems.map((problem) => ({
    endColumn: Math.max(0, problem.endColumn - 1),
    endLine: Math.max(0, problem.endLineNumber - 1),
    message: problem.message,
    severity: workspaceSeverityFromValue(problem.severity),
    ...(problem.source ? { source: problem.source } : {}),
    startColumn: Math.max(0, problem.startColumn - 1),
    startLine: Math.max(0, problem.startLineNumber - 1),
  }));
}

function useWorkspaceEditorPaneComponent(props: WorkspaceEditorPaneProps) {
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
  const [editorFeedbackState, setEditorFeedbackState] = useState<WorkspaceEditorFeedbackState>(
    EMPTY_WORKSPACE_EDITOR_FEEDBACK_STATE,
  );
  const {
    actionError,
    diagnosticError,
    diagnosticSummary,
    diagnostics,
    previewError,
    problems,
    problemsOpen,
  } = editorFeedbackState;
  const [navigationState, dispatchNavigationState] = useReducer(
    workspaceEditorNavigationStateReducer,
    EMPTY_WORKSPACE_EDITOR_NAVIGATION_STATE,
  );
  const { editorMountVersion, pendingNavigationTarget } = navigationState;
  const [selectionState, dispatchSelectionState] = useReducer(
    workspaceEditorSelectionStateReducer,
    EMPTY_WORKSPACE_EDITOR_SELECTION_STATE,
  );
  const {
    cursorLabel,
    activeSelection,
    selectionActionsExpanded,
    selectionCommentSubmitting,
    commentDraft,
  } = selectionState;
  const [textPreviewFilePaths, setTextPreviewFilePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const editorRef = useRef<WorkspaceCodeEditorHandle | null>(null);
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
  const activeLanguageId = resolveWorkspaceLanguageFromFilePath(props.pane.activeFilePath);
  const activeFileCommentCount = useMemo(
    () => countOpenWorkspaceCodeComments(props.codeComments, props.pane.activeFilePath),
    [props.codeComments, props.pane.activeFilePath],
  );
  const workspaceCwd = props.gitCwd ?? props.diagnosticsCwd;
  const latestPaneStateRef = useRef({
    paneId: pane.id,
    activeFilePath: pane.activeFilePath,
  });
  const activeSelectionIdRef = useRef<string | null>(null);
  const onOpenFileInPaneRef = useRef(onOpenFileInPane);

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
        return next.size === current.size &&
          next.has(activeFilePath) === current.has(activeFilePath)
          ? current
          : next;
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

  const activeFileReady =
    pane.activeFilePath !== null &&
    (isPreviewMode || activeDraft !== null || activeFileQuery.data?.contents !== undefined);

  const applyWorkspaceProblems = useCallback(
    (
      activeFilePath: string | null,
      nextDiagnostics: readonly WorkspaceEditorDiagnostic[],
      input?: { diagnosticError?: string | null },
    ) => {
      const nextProblems = nextDiagnostics.map(toWorkspaceEditorPaneProblem);
      setEditorFeedbackState((current) => ({
        ...current,
        diagnostics: nextDiagnostics,
        diagnosticSummary: formatProblemSummary(nextProblems),
        problems: nextProblems,
        ...(input && "diagnosticError" in input
          ? { diagnosticError: input.diagnosticError ?? null }
          : {}),
      }));
      onProblemsChange(pane.id, activeFilePath, nextProblems);
    },
    [onProblemsChange, pane.id],
  );

  const clearWorkspaceProblems = useCallback(
    (input?: { diagnosticError?: string | null }) => {
      applyWorkspaceProblems(pane.activeFilePath, [], input);
    },
    [applyWorkspaceProblems, pane.activeFilePath],
  );

  const handleEditorFocus = useCallback(() => {
    onFocusPane(pane.id);
    dispatchNavigationState({ type: "editor-mounted" });
  }, [onFocusPane, pane.id]);

  const handleCursorLabelChange = useCallback((cursorLabel: string) => {
    dispatchSelectionState({ type: "set-cursor-label", cursorLabel });
  }, []);

  const handleSymbolsChange = useCallback(
    (contents: string) => {
      if (isPreviewMode) {
        onSymbolsChange(pane.id, pane.activeFilePath, []);
        return;
      }
      onSymbolsChange(pane.id, pane.activeFilePath, extractWorkspaceEditorPaneSymbols(contents));
    },
    [isPreviewMode, onSymbolsChange, pane.activeFilePath, pane.id],
  );

  const handleSelectionChange = useCallback(
    (selection: WorkspaceCodeEditorSelection | null) => {
      if (!selection || !workspaceCwd || isPreviewMode) {
        dispatchSelectionState({ type: "clear-selection" });
        activeSelectionIdRef.current = null;
        return;
      }
      if (activeSelectionIdRef.current !== selection.id) {
        activeSelectionIdRef.current = selection.id;
        dispatchSelectionState({ type: "reset-selection-comment" });
      }
      const context = buildWorkspaceSelectionContext({
        cwd: workspaceCwd,
        diagnostics: diagnosticsForSelectionContext(problems),
        languageId: activeLanguageId ?? null,
        range: selection.location,
        text: selection.text,
      });
      dispatchSelectionState({
        type: "set-active-selection",
        activeSelection: {
          context,
          id: selection.id,
          left: selection.left,
          top: selection.top,
        },
      });
    },
    [activeLanguageId, isPreviewMode, problems, workspaceCwd],
  );

  const focusWorkspaceLocation = useCallback((location: WorkspaceEditorLocation) => {
    const editor = editorRef.current;
    const latestPaneState = latestPaneStateRef.current;
    if (!editor) {
      return;
    }
    if (location.relativePath === latestPaneState.activeFilePath) {
      editor.revealLocation(location);
      return;
    }
    dispatchNavigationState({ type: "set-pending-navigation-target", location });
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
        setEditorFeedbackState((current) => ({ ...current, actionError: null }));
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
        setEditorFeedbackState((current) => ({ ...current, actionError: message }));
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

  const handleDefinitionRequest = useCallback(
    (input: { contents: string; line: number; column: number }) => {
      const relativePath = latestPaneStateRef.current.activeFilePath;
      if (!relativePath || isPreviewMode) {
        return;
      }
      void loadDefinitionLocations({
        relativePath,
        contents: input.contents,
        line: input.line,
        column: input.column,
      }).then((locations) => {
        const firstLocation = locations[0];
        if (firstLocation) {
          focusWorkspaceLocation(firstLocation);
        }
      });
    },
    [focusWorkspaceLocation, isPreviewMode, loadDefinitionLocations],
  );

  const handleCompletionRequest = useCallback(
    async (input: {
      contents: string;
      line: number;
      column: number;
    }): Promise<readonly WorkspaceEditorCompletionItem[]> => {
      if (!api || !props.diagnosticsCwd || !pane.activeFilePath || isPreviewMode) {
        return [];
      }
      try {
        const result = await api.workspaceEditor.complete(
          withRpcRouteConnection(
            {
              cwd: props.diagnosticsCwd,
              relativePath: pane.activeFilePath,
              contents: input.contents,
              line: input.line,
              column: input.column,
            },
            props.connectionUrl,
          ),
        );
        return result.items;
      } catch {
        return [];
      }
    },
    [api, isPreviewMode, pane.activeFilePath, props.connectionUrl, props.diagnosticsCwd],
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
    editor.revealLocation(pendingNavigationTarget);
    dispatchNavigationState({ type: "clear-pending-navigation-target" });
  }, [editorMountVersion, pane.activeFilePath, pendingNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    const target = props.problemNavigationTarget;
    if (!editor || !target || pane.activeFilePath !== target.location.relativePath) {
      return;
    }
    editor.revealLocation(target.location);
  }, [editorMountVersion, pane.activeFilePath, props.problemNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    const target = props.symbolNavigationTarget;
    if (!editor || !target || pane.activeFilePath !== target.location.relativePath) {
      return;
    }
    editor.revealLocation(target.location);
  }, [editorMountVersion, pane.activeFilePath, props.symbolNavigationTarget]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !props.active || !props.findRequestToken) {
      return;
    }
    editor.openFindPanel();
  }, [editorMountVersion, props.active, props.findRequestToken]);

  useEffect(() => {
    syncRequestIdRef.current += 1;
    const requestId = syncRequestIdRef.current;
    const activeFilePath = pane.activeFilePath;

    if (isPreviewMode || !api || !props.diagnosticsCwd || !activeFilePath || !activeFileReady) {
      clearWorkspaceProblems({ diagnosticError: null });
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
          diagnosticsUnavailableRetryAtRef.current = 0;
          applyWorkspaceProblems(pane.activeFilePath, result.diagnostics, {
            diagnosticError: null,
          });
        })
        .catch((error) => {
          if (syncRequestIdRef.current !== requestId) {
            return;
          }
          const message = toErrorMessage(error);
          if (isUnavailableWorkspaceDiagnosticsError(error)) {
            diagnosticsUnavailableRetryAtRef.current = Date.now() + DIAGNOSTIC_UNAVAILABLE_RETRY_MS;
          }
          clearWorkspaceProblems({ diagnosticError: message });
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
    applyWorkspaceProblems,
    clearWorkspaceProblems,
    isPreviewMode,
    pane.activeFilePath,
    props.connectionUrl,
    props.diagnosticsCwd,
    props.gitCwd,
  ]);

  useEffect(() => {
    handleSymbolsChange(activeFileContents);
  }, [activeFileContents, handleSymbolsChange]);

  useEffect(
    () => () => {
      syncRequestIdRef.current += 1;
      clearWorkspaceProblems({ diagnosticError: null });
    },
    [clearWorkspaceProblems],
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

  const handleProblemClick = useCallback(
    (problem: WorkspaceEditorPaneProblem) => {
      if (!pane.activeFilePath) {
        return;
      }
      editorRef.current?.revealLocation(
        toWorkspaceLocationFromProblem(pane.activeFilePath, problem),
      );
    },
    [pane.activeFilePath],
  );

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
    dispatchSelectionState({
      type: "set-selection-comment-submitting",
      selectionCommentSubmitting: true,
    });
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
      dispatchSelectionState({
        type: "set-selection-comment-submitting",
        selectionCommentSubmitting: false,
      });
    }
    if (!sent) {
      return;
    }
    dispatchSelectionState({ type: "reset-selection-comment" });
  }, [activeSelection, commentDraft, props, selectionCommentSubmitting, workspaceCwd]);

  useEffect(() => {
    setEditorFeedbackState((current) => ({
      ...current,
      actionError: null,
      previewError: null,
      problemsOpen: false,
    }));
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
        className="flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border bg-card/78 px-1.5"
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
                <Tooltip>
                  <TooltipTrigger
                    render={
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
                        aria-label={filePath}
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
                          role="button"
                          tabIndex={-1}
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
                          aria-label={`Close ${filePath}`}
                        >
                          <XIcon className="size-3" />
                        </span>
                      </button>
                    }
                  />
                  <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
                    {filePath}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
          {dropTargetIndex === props.pane.openFilePaths.length ? (
            <div className="relative flex shrink-0 items-stretch px-0.5">
              <div className="my-1.5 w-[2px] rounded-full bg-primary" />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border/70 px-1">
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  onClick={() => props.onSplitPane(props.pane.id)}
                  disabled={!props.canSplitPane}
                  aria-label="Split editor right"
                />
              }
            >
              <Columns2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Split editor right</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                  onClick={() => props.onSplitPaneDown(props.pane.id)}
                  disabled={!props.canSplitPane}
                  aria-label="Split editor down"
                />
              }
            >
              <Rows2Icon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Split editor down</TooltipPopup>
          </Tooltip>
          {props.canClosePane ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 rounded-lg text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    onClick={() => props.onClosePane(props.pane.id)}
                    aria-label="Close editor group"
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Close editor group</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 bg-background">
        {!props.pane.activeFilePath ? (
          <div className="flex h-full items-center justify-center">
            <div className="pointer-events-none flex items-center justify-center text-foreground opacity-[0.03]">
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
              <div className="flex h-full min-h-[220px] items-center justify-center border border-border/60 bg-card/72">
                {activePreviewKind === "image" ? (
                  <img
                    src={previewUrl}
                    alt={props.pane.activeFilePath}
                    className="max-h-full max-w-full object-contain"
                    onError={() => {
                      setEditorFeedbackState((current) => ({
                        ...current,
                        previewError: "Unable to preview this image in the embedded editor.",
                      }));
                    }}
                  />
                ) : (
                  <video
                    src={previewUrl}
                    controls
                    className="max-h-full max-w-full"
                    onError={() => {
                      setEditorFeedbackState((current) => ({
                        ...current,
                        previewError: "Unable to preview this video in the embedded editor.",
                      }));
                    }}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate">{previewModeLabel}</span>
            </div>
          </div>
        ) : isTextPreviewMode && activeFileQuery.data?.contents !== undefined ? (
          <div className="flex h-full min-h-0 flex-col">
            {activePreviewKind === "markdown" ? (
              <div className="min-h-0 flex-1 overflow-auto bg-background">
                <div className="workspace-markdown-preview mx-auto w-full max-w-4xl px-5 py-5 sm:px-8 sm:py-7">
                  <ChatMarkdown
                    text={activeFileQuery.data.contents}
                    cwd={props.gitCwd ?? undefined}
                    isStreaming={false}
                  />
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <div className="min-h-[220px] border border-border/60 bg-card/72 p-4">
                  <MermaidDiagram
                    source={activeFileQuery.data.contents}
                    theme={props.resolvedTheme}
                    className="h-full"
                  />
                </div>
              </div>
            )}
            <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <span className="truncate">{previewModeLabel}</span>
            </div>
          </div>
        ) : activeFileQuery.isPending && !activeDraft ? (
          <div className="space-y-4 p-6">
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
            <WorkspaceCodeEditor
              ref={editorRef}
              activeFilePath={props.pane.activeFilePath}
              completionProvider={handleCompletionRequest}
              diagnostics={diagnostics}
              languageId={activeLanguageId}
              onChange={(value) => {
                props.onUpdateDraft(props.pane.activeFilePath!, value);
              }}
              onCursorLabelChange={handleCursorLabelChange}
              onDefinitionRequest={handleDefinitionRequest}
              onFocus={handleEditorFocus}
              onSave={handleSave}
              onSelectionChange={handleSelectionChange}
              onSymbolsChange={handleSymbolsChange}
              onToggleProblems={() => {
                setEditorFeedbackState((current) => ({
                  ...current,
                  problemsOpen: !current.problemsOpen,
                }));
              }}
              options={props.editorOptions}
              resolvedTheme={props.resolvedTheme}
              value={activeFileContents}
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
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex size-7 items-center justify-center rounded-full border border-border/70 bg-background/92 text-muted-foreground/75 shadow-sm backdrop-blur hover:bg-accent hover:text-foreground"
                          onClick={() =>
                            dispatchSelectionState({
                              type: "set-selection-actions-expanded",
                              selectionActionsExpanded: !selectionActionsExpanded,
                            })
                          }
                          aria-label="Open selection actions"
                        />
                      }
                    >
                      <SparklesIcon className="size-3 text-primary/85" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Selection actions</TooltipPopup>
                  </Tooltip>
                ) : (
                  <div className="flex h-12 w-[min(380px,calc(100vw-20px))] items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 shadow-[0_16px_38px_rgba(0,0,0,0.18)] backdrop-blur-xl">
                    <input
                      value={commentDraft}
                      onChange={(event) =>
                        dispatchSelectionState({
                          type: "set-comment-draft",
                          commentDraft: event.target.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleAddAndSendSelectionComment();
                          return;
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          dispatchSelectionState({
                            type: "set-selection-actions-expanded",
                            selectionActionsExpanded: false,
                          });
                        }
                      }}
                      placeholder="Comment for the agent"
                      className="h-9 min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] font-medium outline-none placeholder:text-muted-foreground/55"
                    />
                    {props.onAddCodeCommentAndSend ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                              disabled={
                                commentDraft.trim().length === 0 || selectionCommentSubmitting
                              }
                              aria-label="Submit comment"
                              onClick={() => {
                                void handleAddAndSendSelectionComment();
                              }}
                            />
                          }
                        >
                          <ArrowUpRightIcon className="size-4" />
                        </TooltipTrigger>
                        <TooltipPopup side="top">Submit comment</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!isPreviewMode && problemsOpen ? (
        <section className="shrink-0 border-t border-border bg-card/72">
          <header className="flex h-8 items-center justify-between border-b border-border/70 bg-transparent px-3 text-[11px] text-muted-foreground">
            <span className="font-medium tracking-[0.08em] uppercase">Problems</span>
            <span className="px-1.5 py-px text-[10px] text-foreground/75">
              {sortedProblems.length}
            </span>
          </header>
          <ScrollArea className="max-h-44">
            {sortedProblems.length > 0 ? (
              <div className="py-1">
                {sortedProblems.map((problem) => {
                  const severity = workspaceSeverityFromValue(problem.severity);
                  return (
                    <Button
                      key={`${problem.owner}:${problem.startLineNumber}:${problem.startColumn}:${problem.message}`}
                      type="button"
                      variant="ghost"
                      className="mx-1 flex h-auto w-[calc(100%-0.5rem)] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-normal"
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
                    </Button>
                  );
                })}
              </div>
            ) : (
              <p className="px-2.5 py-2 text-[11px] text-muted-foreground">No problems detected.</p>
            )}
          </ScrollArea>
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-[18rem] truncate text-destructive/80">{actionError}</span>
                }
              />
              <TooltipPopup side="top" align="end" className="max-w-96 whitespace-pre-wrap">
                {actionError}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {previewError ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-[18rem] truncate text-destructive/80">{previewError}</span>
                }
              />
              <TooltipPopup side="top" align="end" className="max-w-96 whitespace-pre-wrap">
                {previewError}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {diagnosticError ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-[18rem] truncate text-destructive/80">
                    {diagnosticError}
                  </span>
                }
              />
              <TooltipPopup side="top" align="end" className="max-w-96 whitespace-pre-wrap">
                {diagnosticError}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {props.pane.activeFilePath && !isPreviewMode ? (
            <span className="rounded-md bg-foreground/5 px-1.5 py-px text-foreground/65">
              {cursorLabel}
            </span>
          ) : null}
          {activeLanguageId && !isPreviewMode ? (
            <span className="rounded-md bg-foreground/5 px-1.5 py-px text-foreground/65">
              {activeLanguageId}
            </span>
          ) : null}
          {props.pane.activeFilePath && !isPreviewMode ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-px text-foreground/75 transition-[background-color,color] hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      setEditorFeedbackState((current) => ({
                        ...current,
                        problemsOpen: !current.problemsOpen,
                      }));
                    }}
                    aria-label={
                      diagnosticSummary
                        ? `${diagnosticSummary}. ${problemsOpen ? "Hide" : "Show"} problems panel`
                        : `${problemsOpen ? "Hide" : "Show"} problems panel`
                    }
                  >
                    {diagnosticSummary ?? "No problems"}
                  </button>
                }
              />
              <TooltipPopup side="top" align="end">
                {diagnosticSummary
                  ? `${diagnosticSummary}. ${problemsOpen ? "Hide" : "Show"} problems panel`
                  : `${problemsOpen ? "Hide" : "Show"} problems panel`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <Button
              type="button"
              variant="ghost"
              className="h-auto rounded-md px-1.5 py-px text-foreground/72 hover:text-foreground"
              onClick={() => props.onDiscardDraft(props.pane.activeFilePath!)}
              aria-label="Revert changes"
            >
              Revert
            </Button>
          ) : null}
          {props.pane.activeFilePath && activeFileDirty ? (
            <Button
              type="button"
              variant="ghost"
              className="h-auto rounded-md bg-foreground/10 px-1.5 py-px font-medium text-foreground hover:bg-foreground/14"
              onClick={handleSave}
              disabled={props.savingFilePath === props.pane.activeFilePath}
              aria-label="Save file"
            >
              {props.savingFilePath === props.pane.activeFilePath ? "Saving…" : "Save"}
            </Button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function WorkspaceEditorPane(props: WorkspaceEditorPaneProps) {
  return useWorkspaceEditorPaneComponent(props);
}

const MemoizedWorkspaceEditorPane = memo(WorkspaceEditorPane);
MemoizedWorkspaceEditorPane.displayName = "WorkspaceEditorPane";

export default MemoizedWorkspaceEditorPane;
