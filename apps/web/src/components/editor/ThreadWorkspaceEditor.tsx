import type {
  EditorId,
  GitWorkingTreeFileStatus,
  ProjectEntry,
  ProjectReadFileResult,
  ResolvedKeybindingsConfig,
  ThreadId,
  WorkspaceEditorLocation,
} from "@ace/contracts";
import * as Schema from "effect/Schema";
import {
  IconFiles,
  IconArrowsDiagonalMinimize2,
  IconGitCompare,
  IconSearch,
} from "@tabler/icons-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BoxIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ClipboardListIcon,
  Code2Icon,
  ExternalLinkIcon,
  FilePlus2Icon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  HashIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
} from "react";

import {
  resolveEditorInstanceStateScopeId,
  resolveEditorWindowStateInstanceId,
  type ThreadEditorRowState,
  MAX_THREAD_EDITOR_PANES,
  selectThreadEditorState,
  useEditorStateStore,
} from "~/editorStateStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSetting, useUpdateSettings } from "~/hooks/useSettings";
import { useReactCompilerSafeVirtualizer } from "~/hooks/useReactCompilerSafeVirtualizer";
import { useTheme } from "~/hooks/useTheme";
import { isTerminalFocused } from "~/lib/terminalFocus";
import {
  createWorkspaceDiffEditorOptions,
  createWorkspaceEditorOptions,
} from "~/lib/editor/workspaceEditorOptions";
import {
  buildWorkspaceCodeSearchQueries,
  createWorkspaceCodeSearchResult,
  groupWorkspaceCodeSearchResults,
  highlightWorkspaceCodeSearchText,
  sortWorkspaceCodeSearchResults,
  type WorkspaceCodeSearchResult,
} from "~/lib/editor/workspaceCodeSearch";
import { searchWorkspaceEntriesLocally } from "~/lib/editor/workspaceEntrySearch";
import { resolveWorkspaceLanguageFromFilePath } from "~/lib/editor/workspaceLanguageMapping";
import {
  buildWorkspaceCodeCommentPrompt,
  countOpenWorkspaceCodeComments,
  formatWorkspaceCodeCommentTitle,
  type WorkspaceCodeComment,
  type WorkspaceSelectionContext,
} from "~/lib/editor/workspaceDesigner";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { normalizePaneRatios, resizePaneRatios } from "~/lib/paneRatios";
import {
  projectListTreeQueryOptions,
  projectQueryKeys,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import { withRpcRouteConnection } from "~/lib/connectionRouting";
import {
  APP_EDITOR_CHROME_HEADER_CLASS_NAME,
  APP_SETTINGS_FIELD_CLASS_NAME,
  APP_WORKSPACE_INSET_CLASS_NAME,
} from "~/lib/appChrome";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { readExplorerEntryTransferPath, writeExplorerEntryTransfer } from "./dragTransfer";
import {
  detectWorkspacePreviewKind,
  joinWorkspaceAbsolutePath,
  revealInFileManagerLabel,
} from "./workspaceFileUtils";
import WorkspaceEditorPane, {
  type WorkspaceEditorPaneProblem,
  type WorkspaceEditorPaneSymbol,
  type WorkspaceEditorProblemNavigationTarget,
  type WorkspaceEditorSymbolNavigationTarget,
} from "./WorkspaceEditorPane";
import WorkspaceDiffEditor from "./WorkspaceDiffEditor";
import WorkspaceReviewPane from "./WorkspaceReviewPane";
import {
  WorkspaceCommandPalette,
  type WorkspaceCommandAction,
  type WorkspaceCommandPaletteMode,
} from "./WorkspaceCommandPalette";

const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];
const WORKSPACE_TREE_REFETCH_INTERVAL_MS = 10_000;
const WORKSPACE_SEARCH_RESULT_LIMIT = 400;
const WORKSPACE_CODE_SEARCH_LOCAL_CANDIDATE_LIMIT = 32;
const WORKSPACE_CODE_SEARCH_REMOTE_LIMIT = 48;
const WORKSPACE_CODE_SEARCH_MAX_CANDIDATE_FILES = 36;
const WORKSPACE_CODE_SEARCH_PATH_RESULT_LIMIT = 24;
const WORKSPACE_CODE_SEARCH_DEBOUNCE_MS = 250;
const WORKSPACE_EXPLORER_FILE_PREFETCH_LIMIT = 24;
const WORKSPACE_FILE_CONFLICT_DIFF_HEIGHT = 420;
const WORKSPACE_CODE_SEARCH_RECENTS_STORAGE_KEY = "ace:workspace-code-search-recents:v1";
const WORKSPACE_CODE_SEARCH_RECENT_LIMIT = 6;
const WORKSPACE_CODE_SEARCH_EXAMPLE_QUERIES = [
  "auth token refresh",
  "content:useMutation",
  "re:.*\\.test\\.tsx$",
] as const;
const WorkspaceCodeSearchRecentsSchema = Schema.Array(Schema.String);
const WORKSPACE_SIDEBAR_SEARCH_INPUT_CLASS = cn(
  APP_SETTINGS_FIELD_CLASS_NAME,
  "h-8 rounded-md text-[12px] placeholder:text-muted-foreground/48 focus-within:border-primary/40 [&_[data-slot=input]]:h-full [&_[data-slot=input]]:pr-2 [&_[data-slot=input]]:pl-9 [&_[data-slot=input]]:leading-8",
);
const WORKSPACE_SIDEBAR_PRIMARY_MODE_BUTTON_CLASS =
  "relative flex size-8 items-center justify-center rounded-md bg-transparent outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/45";
const WORKSPACE_SIDEBAR_PRIMARY_MODE_ICON_CLASS = "size-[19px] shrink-0 transition-colors";
const WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS =
  "size-7 shrink-0 rounded-md bg-transparent text-muted-foreground/58 hover:bg-transparent hover:text-foreground";
const WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS = "size-[15px] shrink-0";
const WORKSPACE_EDITOR_CHROME_PRIMARY_BUTTON_CLASS =
  "size-[30px] rounded-lg text-muted-foreground/72 hover:bg-foreground/[0.05] hover:text-foreground";
const WORKSPACE_EDITOR_CHROME_PRIMARY_ICON_CLASS = "size-[17px]";
const WORKSPACE_EXPLORER_ROW_CLASS =
  "group flex h-[22px] w-full items-center gap-1.5 rounded-[2px] px-2 text-left text-[12px] outline-none transition-colors";
const WORKSPACE_EXPLORER_ACTIVE_ROW_CLASS =
  "!bg-foreground/[0.06] !text-pill-foreground hover:!bg-foreground/[0.06] hover:!text-pill-foreground";
const WORKSPACE_EXPLORER_SELECTED_ROW_CLASS =
  "!bg-foreground/[0.06] !text-pill-foreground hover:!bg-foreground/[0.06] hover:!text-pill-foreground";
const WORKSPACE_EXPLORER_DROP_ROW_CLASS =
  "bg-[color-mix(in_srgb,var(--primary)_24%,transparent)] text-foreground";
const WORKSPACE_EXPLORER_IDLE_ROW_CLASS =
  "text-muted-foreground/90 hover:bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] hover:text-foreground";

interface SaveConflictState {
  readonly currentContents: string;
  readonly currentVersion?: string;
  readonly expectedVersion?: string;
  readonly localContents: string;
  readonly relativePath: string;
}

interface WorkspaceProblemReport {
  readonly paneId: string;
  readonly relativePath: string;
  readonly problem: WorkspaceEditorPaneProblem;
}

interface WorkspaceSymbolReport {
  readonly paneId: string;
  readonly relativePath: string;
  readonly symbol: WorkspaceEditorPaneSymbol;
}

interface WorkspaceOutlineSymbolNode {
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly id: string;
  readonly report: WorkspaceSymbolReport;
}

interface WorkspaceOutlineFileGroup {
  readonly id: string;
  readonly relativePath: string;
  readonly symbolCount: number;
  readonly symbols: readonly WorkspaceOutlineSymbolNode[];
}

function readConflictField(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return Reflect.get(error, key);
}

function parseSaveConflictState(
  error: unknown,
  variables: { contents: string; relativePath: string },
): SaveConflictState | null {
  const conflict = readConflictField(error, "conflict");
  const currentContents = readConflictField(error, "currentContents");
  if (conflict !== true || typeof currentContents !== "string") {
    return null;
  }
  const currentVersion = readConflictField(error, "currentVersion");
  const expectedVersion = readConflictField(error, "expectedVersion");
  return {
    currentContents,
    localContents: variables.contents,
    relativePath: variables.relativePath,
    ...(typeof currentVersion === "string" ? { currentVersion } : {}),
    ...(typeof expectedVersion === "string" ? { expectedVersion } : {}),
  };
}

type TreeRow =
  | {
      depth: number;
      entry: ProjectEntry;
      hasChildren: boolean;
      kind: "directory";
      name: string;
    }
  | {
      depth: number;
      entry: ProjectEntry;
      hasChildren: false;
      kind: "file";
      name: string;
    };

type ExplorerInlineEntryState =
  | {
      kind: "create-file";
      parentPath: string | null;
      value: string;
    }
  | {
      kind: "create-folder";
      parentPath: string | null;
      value: string;
    }
  | {
      entry: ProjectEntry;
      kind: "rename";
      parentPath: string | null;
      value: string;
    };

type ExplorerRenderRow =
  | {
      kind: "entry";
      key: string;
      row: TreeRow;
    }
  | {
      depth: number;
      key: string;
      kind: "inline";
      state: ExplorerInlineEntryState;
    };

type WorkspaceSidebarMode =
  | "explorer"
  | "search"
  | "review"
  | "source-control"
  | "outline"
  | "problems"
  | "notes";

interface QueuedWorkspaceContext {
  readonly context: WorkspaceSelectionContext;
  readonly createdAt: string;
  readonly id: string;
  readonly prompt: string;
}

interface WorkspaceAgentNoteSubmission {
  readonly mode: "queue" | "send";
  readonly prompt: string;
  readonly threadId?: ThreadId;
}

type ThreadWorkspaceEditorUiState = {
  treeSearch: string;
  codeSearchQuery: string;
  sidebarMode: WorkspaceSidebarMode;
  commandPaletteOpen: boolean;
  commandPaletteMode: WorkspaceCommandPaletteMode;
  queuedWorkspaceContexts: readonly QueuedWorkspaceContext[];
  agentNoteSubmissionBusy: boolean;
  selectedEntryPath: string | null;
  inlineEntryState: ExplorerInlineEntryState | null;
  dragTargetParentPath: string | null;
  saveConflict: SaveConflictState | null;
  selectedReviewFilePath: string | null;
  problemReportsByPaneId: Record<
    string,
    { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
  >;
  symbolReportsByPaneId: Record<
    string,
    { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
  >;
  problemNavigationTarget: WorkspaceEditorProblemNavigationTarget | null;
  symbolNavigationTarget: WorkspaceEditorSymbolNavigationTarget | null;
  findRequestToken: number;
  collapsedOutlineIds: ReadonlySet<string>;
  activeOutlineSymbolId: string | null;
};

type ThreadWorkspaceEditorUiAction =
  | { type: "set-tree-search"; treeSearch: string }
  | { type: "set-code-search-query"; codeSearchQuery: string }
  | { type: "set-sidebar-mode"; sidebarMode: WorkspaceSidebarMode }
  | { type: "set-command-palette-open"; commandPaletteOpen: boolean }
  | { type: "set-command-palette-mode"; commandPaletteMode: WorkspaceCommandPaletteMode }
  | {
      type: "set-queued-workspace-contexts";
      nextQueuedWorkspaceContexts:
        | readonly QueuedWorkspaceContext[]
        | ((current: readonly QueuedWorkspaceContext[]) => readonly QueuedWorkspaceContext[]);
    }
  | { type: "set-agent-note-submission-busy"; agentNoteSubmissionBusy: boolean }
  | { type: "set-selected-entry-path"; selectedEntryPath: string | null }
  | {
      type: "set-inline-entry-state";
      inlineEntryState:
        | ExplorerInlineEntryState
        | null
        | ((current: ExplorerInlineEntryState | null) => ExplorerInlineEntryState | null);
    }
  | { type: "set-drag-target-parent-path"; dragTargetParentPath: string | null }
  | {
      type: "set-save-conflict";
      saveConflict:
        | SaveConflictState
        | null
        | ((current: SaveConflictState | null) => SaveConflictState | null);
    }
  | {
      type: "set-selected-review-file-path";
      selectedReviewFilePath: string | null | ((current: string | null) => string | null);
    }
  | {
      type: "set-problem-reports-by-pane-id";
      nextProblemReportsByPaneId:
        | Record<
            string,
            { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
          >
        | ((
            current: Record<
              string,
              { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
            >,
          ) => Record<
            string,
            { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
          >);
    }
  | {
      type: "set-symbol-reports-by-pane-id";
      nextSymbolReportsByPaneId:
        | Record<
            string,
            { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
          >
        | ((
            current: Record<
              string,
              { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
            >,
          ) => Record<
            string,
            { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
          >);
    }
  | {
      type: "set-problem-navigation-target";
      problemNavigationTarget: WorkspaceEditorProblemNavigationTarget | null;
    }
  | {
      type: "set-symbol-navigation-target";
      symbolNavigationTarget: WorkspaceEditorSymbolNavigationTarget | null;
    }
  | { type: "bump-find-request-token" }
  | {
      type: "set-collapsed-outline-ids";
      nextCollapsedOutlineIds:
        | ReadonlySet<string>
        | ((current: ReadonlySet<string>) => ReadonlySet<string>);
    }
  | {
      type: "set-active-outline-symbol-id";
      activeOutlineSymbolId: string | null | ((current: string | null) => string | null);
    };

const EMPTY_THREAD_WORKSPACE_EDITOR_UI_STATE: ThreadWorkspaceEditorUiState = {
  treeSearch: "",
  codeSearchQuery: "",
  sidebarMode: "explorer",
  commandPaletteOpen: false,
  commandPaletteMode: "commands",
  queuedWorkspaceContexts: [],
  agentNoteSubmissionBusy: false,
  selectedEntryPath: null,
  inlineEntryState: null,
  dragTargetParentPath: null,
  saveConflict: null,
  selectedReviewFilePath: null,
  problemReportsByPaneId: {},
  symbolReportsByPaneId: {},
  problemNavigationTarget: null,
  symbolNavigationTarget: null,
  findRequestToken: 0,
  collapsedOutlineIds: new Set(),
  activeOutlineSymbolId: null,
};

function threadWorkspaceEditorUiStateReducer(
  state: ThreadWorkspaceEditorUiState,
  action: ThreadWorkspaceEditorUiAction,
): ThreadWorkspaceEditorUiState {
  switch (action.type) {
    case "set-tree-search":
      return { ...state, treeSearch: action.treeSearch };
    case "set-code-search-query":
      return { ...state, codeSearchQuery: action.codeSearchQuery };
    case "set-sidebar-mode":
      return { ...state, sidebarMode: action.sidebarMode };
    case "set-command-palette-open":
      return { ...state, commandPaletteOpen: action.commandPaletteOpen };
    case "set-command-palette-mode":
      return { ...state, commandPaletteMode: action.commandPaletteMode };
    case "set-queued-workspace-contexts": {
      const nextQueuedWorkspaceContexts =
        typeof action.nextQueuedWorkspaceContexts === "function"
          ? action.nextQueuedWorkspaceContexts(state.queuedWorkspaceContexts)
          : action.nextQueuedWorkspaceContexts;
      return nextQueuedWorkspaceContexts === state.queuedWorkspaceContexts
        ? state
        : { ...state, queuedWorkspaceContexts: nextQueuedWorkspaceContexts };
    }
    case "set-agent-note-submission-busy":
      return { ...state, agentNoteSubmissionBusy: action.agentNoteSubmissionBusy };
    case "set-selected-entry-path":
      return { ...state, selectedEntryPath: action.selectedEntryPath };
    case "set-inline-entry-state": {
      const inlineEntryState =
        typeof action.inlineEntryState === "function"
          ? action.inlineEntryState(state.inlineEntryState)
          : action.inlineEntryState;
      return inlineEntryState === state.inlineEntryState ? state : { ...state, inlineEntryState };
    }
    case "set-drag-target-parent-path":
      return { ...state, dragTargetParentPath: action.dragTargetParentPath };
    case "set-save-conflict": {
      const saveConflict =
        typeof action.saveConflict === "function"
          ? action.saveConflict(state.saveConflict)
          : action.saveConflict;
      return saveConflict === state.saveConflict ? state : { ...state, saveConflict };
    }
    case "set-selected-review-file-path": {
      const selectedReviewFilePath =
        typeof action.selectedReviewFilePath === "function"
          ? action.selectedReviewFilePath(state.selectedReviewFilePath)
          : action.selectedReviewFilePath;
      return selectedReviewFilePath === state.selectedReviewFilePath
        ? state
        : { ...state, selectedReviewFilePath };
    }
    case "set-problem-reports-by-pane-id": {
      const problemReportsByPaneId =
        typeof action.nextProblemReportsByPaneId === "function"
          ? action.nextProblemReportsByPaneId(state.problemReportsByPaneId)
          : action.nextProblemReportsByPaneId;
      return problemReportsByPaneId === state.problemReportsByPaneId
        ? state
        : { ...state, problemReportsByPaneId };
    }
    case "set-symbol-reports-by-pane-id": {
      const symbolReportsByPaneId =
        typeof action.nextSymbolReportsByPaneId === "function"
          ? action.nextSymbolReportsByPaneId(state.symbolReportsByPaneId)
          : action.nextSymbolReportsByPaneId;
      return symbolReportsByPaneId === state.symbolReportsByPaneId
        ? state
        : { ...state, symbolReportsByPaneId };
    }
    case "set-problem-navigation-target":
      return { ...state, problemNavigationTarget: action.problemNavigationTarget };
    case "set-symbol-navigation-target":
      return { ...state, symbolNavigationTarget: action.symbolNavigationTarget };
    case "bump-find-request-token":
      return { ...state, findRequestToken: state.findRequestToken + 1 };
    case "set-collapsed-outline-ids": {
      const collapsedOutlineIds =
        typeof action.nextCollapsedOutlineIds === "function"
          ? action.nextCollapsedOutlineIds(state.collapsedOutlineIds)
          : action.nextCollapsedOutlineIds;
      return collapsedOutlineIds === state.collapsedOutlineIds
        ? state
        : { ...state, collapsedOutlineIds };
    }
    case "set-active-outline-symbol-id": {
      const activeOutlineSymbolId =
        typeof action.activeOutlineSymbolId === "function"
          ? action.activeOutlineSymbolId(state.activeOutlineSymbolId)
          : action.activeOutlineSymbolId;
      return activeOutlineSymbolId === state.activeOutlineSymbolId
        ? state
        : { ...state, activeOutlineSymbolId };
    }
    default:
      return state;
  }
}

function compareProjectEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return basenameOfPath(left.path).localeCompare(basenameOfPath(right.path));
}

function collectAncestorDirectories(pathValue: string | null): string[] {
  if (!pathValue) {
    return [];
  }
  const segments = pathValue.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

function buildTreeRows(
  entries: readonly ProjectEntry[],
  expandedDirectoryPaths: ReadonlySet<string>,
): TreeRow[] {
  const childrenByParent = new Map<string | undefined, ProjectEntry[]>();
  for (const entry of entries) {
    const existing = childrenByParent.get(entry.parentPath);
    if (existing) {
      existing.push(entry);
    } else {
      childrenByParent.set(entry.parentPath, [entry]);
    }
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareProjectEntries);
  }

  const rows: TreeRow[] = [];
  const visit = (parentPath: string | undefined, depth: number) => {
    const children = childrenByParent.get(parentPath) ?? [];
    for (const entry of children) {
      const name = basenameOfPath(entry.path);
      const hasChildren = (childrenByParent.get(entry.path)?.length ?? 0) > 0;
      if (entry.kind === "directory") {
        rows.push({ depth, entry, hasChildren, kind: "directory", name });
        if (expandedDirectoryPaths.has(entry.path)) {
          visit(entry.path, depth + 1);
        }
        continue;
      }
      rows.push({ depth, entry, hasChildren: false, kind: "file", name });
    }
  };

  visit(undefined, 0);
  return rows;
}

function pathForDialogInput(parentPath: string | null, value: string): string {
  const trimmed = value.trim().replace(/^\.\//, "");
  return parentPath ? `${parentPath}/${trimmed}` : trimmed;
}

function pathForInlineEntryIcon(state: ExplorerInlineEntryState): string {
  if (state.kind === "rename") {
    return state.entry.path;
  }
  const value = state.value.trim();
  if (value.length > 0) {
    return pathForDialogInput(state.parentPath, value);
  }
  return state.parentPath ? `${state.parentPath}/` : "";
}

function isAncestorPath(pathValue: string, maybeAncestor: string): boolean {
  return pathValue === maybeAncestor || pathValue.startsWith(`${maybeAncestor}/`);
}

function movePathToParent(pathValue: string, nextParentPath: string | null): string {
  const name = basenameOfPath(pathValue);
  return nextParentPath ? `${nextParentPath}/${name}` : name;
}

function buildExplorerRenderRows(
  rows: readonly TreeRow[],
  inlineState: ExplorerInlineEntryState | null,
): ExplorerRenderRow[] {
  const baseRows = rows.map<ExplorerRenderRow>((row) => ({
    kind: "entry",
    key: row.entry.path,
    row,
  }));
  if (!inlineState) {
    return baseRows;
  }

  if (inlineState.kind === "rename") {
    const renameIndex = rows.findIndex((row) => row.entry.path === inlineState.entry.path);
    if (renameIndex < 0) {
      return baseRows;
    }
    const targetRow = rows[renameIndex];
    if (!targetRow) {
      return baseRows;
    }
    baseRows.splice(renameIndex, 1, {
      depth: targetRow.depth,
      key: `inline:${inlineState.entry.path}`,
      kind: "inline",
      state: inlineState,
    });
    return baseRows;
  }

  const parentIndex = inlineState.parentPath
    ? rows.findIndex((row) => row.entry.path === inlineState.parentPath)
    : -1;
  let insertIndex = baseRows.length;
  let depth = 0;
  if (parentIndex >= 0) {
    const parentRow = rows[parentIndex];
    if (parentRow) {
      depth = parentRow.depth + 1;
      insertIndex = parentIndex + 1;
      while (insertIndex < rows.length && (rows[insertIndex]?.depth ?? 0) > parentRow.depth) {
        insertIndex += 1;
      }
    }
  }

  baseRows.splice(insertIndex, 0, {
    depth,
    key: `inline:${inlineState.kind}:${inlineState.parentPath ?? "root"}`,
    kind: "inline",
    state: inlineState,
  });
  return baseRows;
}

function gitDecorationClass(status: GitWorkingTreeFileStatus): string {
  switch (status) {
    case "A":
      return "text-success";
    case "U":
      return "text-emerald-500";
    case "D":
      return "text-destructive";
    case "C":
      return "text-rose-500";
    case "R":
      return "text-sky-500";
    case "M":
    default:
      return "text-amber-500";
  }
}

function problemSeverityRank(severity: number): number {
  return severity;
}

function problemSeverityLabel(severity: number): string {
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

function problemSeverityClass(severity: number): string {
  const label = problemSeverityLabel(severity);
  switch (label) {
    case "error":
      return "bg-destructive/15 text-destructive";
    case "warning":
      return "bg-amber-500/15 text-amber-600";
    case "info":
      return "bg-sky-500/15 text-sky-600";
    default:
      return "bg-foreground/10 text-muted-foreground";
  }
}

function workspaceSymbolNodeId(report: WorkspaceSymbolReport): string {
  return [
    report.paneId,
    report.relativePath,
    report.symbol.kind,
    report.symbol.name,
    report.symbol.startLineNumber,
    report.symbol.startColumn,
    report.symbol.endLineNumber,
    report.symbol.endColumn,
  ].join(":");
}

function symbolKindLabel(kind: string): string {
  switch (kind) {
    case "function":
      return "fn";
    case "method":
      return "method";
    case "interface":
      return "iface";
    case "class":
      return "class";
    case "struct":
      return "struct";
    case "property":
      return "prop";
    case "field":
      return "field";
    case "enum":
      return "enum";
    case "type":
      return "type";
    case "variable":
      return "var";
    default:
      return kind;
  }
}

function symbolKindClass(kind: string): string {
  switch (kind) {
    case "function":
      return "bg-sky-500/12 text-sky-600";
    case "class":
    case "struct":
      return "bg-violet-500/12 text-violet-600";
    case "interface":
    case "trait":
      return "bg-emerald-500/12 text-emerald-600";
    case "type":
    case "enum":
      return "bg-amber-500/12 text-amber-600";
    case "variable":
      return "bg-foreground/10 text-muted-foreground";
    default:
      return "bg-primary/12 text-primary";
  }
}

function symbolKindIcon(kind: string): ReactNode {
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "function":
      return <Code2Icon className={`${className} text-sky-600`} />;
    case "method":
      return <Code2Icon className={`${className} text-indigo-600`} />;
    case "class":
    case "struct":
      return <BoxIcon className={`${className} text-violet-600`} />;
    case "interface":
    case "trait":
      return <ListTreeIcon className={`${className} text-emerald-600`} />;
    case "property":
    case "field":
      return <CircleDotIcon className={`${className} text-cyan-600`} />;
    case "type":
    case "enum":
      return <HashIcon className={`${className} text-amber-600`} />;
    case "impl":
      return <GitBranchIcon className={`${className} text-primary`} />;
    case "variable":
      return <CircleDotIcon className={`${className} text-muted-foreground/70`} />;
    default:
      return <CircleDotIcon className={`${className} text-muted-foreground/62`} />;
  }
}

function buildCombinedAgentNotesPrompt(
  contexts: readonly QueuedWorkspaceContext[],
  comments: readonly WorkspaceCodeComment[],
): string {
  const sections: string[] = [];
  for (const entry of contexts) {
    sections.push(entry.prompt.trim());
  }
  for (const comment of comments) {
    sections.push(buildWorkspaceCodeCommentPrompt(comment));
  }
  return sections.join("\n\n");
}

function formatQueuedWorkspaceContextDetail(entry: QueuedWorkspaceContext): string {
  const prompt = entry.prompt.trim();
  const reviewPrefix = `Review the working tree changes in ${entry.context.relativePath}`;
  if (prompt === `${reviewPrefix}.` || prompt.startsWith(`${reviewPrefix}. `)) {
    return "Working tree changes";
  }
  if (entry.context.text.trim().length === 0) {
    return "Whole file";
  }
  const startLine = entry.context.range.startLine + 1;
  const endLine = entry.context.range.endLine + 1;
  return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
}

function formatQueuedWorkspaceContextKind(entry: QueuedWorkspaceContext): string {
  const prompt = entry.prompt.trim();
  const reviewPrefix = `Review the working tree changes in ${entry.context.relativePath}`;
  if (prompt === `${reviewPrefix}.` || prompt.startsWith(`${reviewPrefix}. `)) {
    return "Review";
  }
  if (entry.context.text.trim().length === 0) {
    return "File";
  }
  return "Selection";
}

function shouldIgnoreEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".cm-editor")) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function shouldPrefetchWorkspaceEditorFile(filePath: string): boolean {
  const previewKind = detectWorkspacePreviewKind(filePath);
  return previewKind !== "image" && previewKind !== "video";
}

function FileTreeRow(props: {
  dragTargetPath: string | null;
  expandedDirectoryPaths: ReadonlySet<string>;
  focusedFilePath: string | null;
  gitStatus: GitWorkingTreeFileStatus | null;
  onDropEntry: (sourcePath: string, targetParentPath: string | null) => void;
  onFocusEntry: (path: string) => void;
  onHoverDropTarget: (targetParentPath: string | null) => void;
  onOpenFile: (filePath: string, openInNewPane: boolean) => void;
  onPrefetchFile: (filePath: string) => void;
  onRevealDirectoryFromSearch: (directoryPath: string) => void;
  onOpenRowContextMenu: (entry: ProjectEntry, position: { x: number; y: number }) => void;
  onSelectEntry: (path: string) => void;
  onToggleDirectory: (directoryPath: string) => void;
  resolvedTheme: "light" | "dark";
  row: TreeRow;
  searchMode: boolean;
  selectedEntryPath: string | null;
}) {
  const isFocused = props.focusedFilePath === props.row.entry.path;
  const isSelected = props.selectedEntryPath === props.row.entry.path;
  const dropTargetPath =
    props.row.kind === "directory" ? props.row.entry.path : (props.row.entry.parentPath ?? null);
  const isDropTarget = props.dragTargetPath !== null && props.dragTargetPath === dropTargetPath;
  const isExpanded =
    props.row.kind === "directory" && props.expandedDirectoryPaths.has(props.row.entry.path);
  const prefetchFile = () => {
    if (props.row.kind === "file") {
      props.onPrefetchFile(props.row.entry.path);
    }
  };

  return (
    <button
      type="button"
      className={cn(
        WORKSPACE_EXPLORER_ROW_CLASS,
        isFocused
          ? WORKSPACE_EXPLORER_ACTIVE_ROW_CLASS
          : isSelected
            ? WORKSPACE_EXPLORER_SELECTED_ROW_CLASS
            : isDropTarget
              ? WORKSPACE_EXPLORER_DROP_ROW_CLASS
              : WORKSPACE_EXPLORER_IDLE_ROW_CLASS,
      )}
      data-explorer-path={props.row.entry.path}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 10}px`,
      }}
      draggable
      onClick={(event) => {
        props.onSelectEntry(props.row.entry.path);
        if (props.row.kind === "directory") {
          if (props.searchMode) {
            props.onRevealDirectoryFromSearch(props.row.entry.path);
            return;
          }
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path, event.altKey || event.metaKey);
      }}
      onFocus={() => {
        props.onFocusEntry(props.row.entry.path);
        prefetchFile();
      }}
      onPointerEnter={prefetchFile}
      onPointerDown={prefetchFile}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        writeExplorerEntryTransfer(event.dataTransfer, {
          kind: props.row.entry.kind,
          path: props.row.entry.path,
        });
      }}
      onDragOver={(event) => {
        if (!readExplorerEntryTransferPath(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onHoverDropTarget(dropTargetPath);
      }}
      onDragLeave={() => {
        props.onHoverDropTarget(null);
      }}
      onDrop={(event) => {
        const path = readExplorerEntryTransferPath(event.dataTransfer);
        if (!path) {
          return;
        }
        event.preventDefault();
        props.onHoverDropTarget(null);
        props.onDropEntry(path, dropTargetPath);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onSelectEntry(props.row.entry.path);
        props.onOpenRowContextMenu(props.row.entry, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      aria-label={
        props.row.kind === "file"
          ? `${props.row.entry.path} • Option-click to open in a new window • Right-click for actions`
          : props.row.entry.path
      }
    >
      {props.row.kind === "directory" ? (
        props.row.hasChildren ? (
          isExpanded ? (
            <ChevronDownIcon
              className="size-3.5 shrink-0 text-muted-foreground/80"
              strokeWidth={2}
            />
          ) : (
            <ChevronRightIcon
              className="size-3.5 shrink-0 text-muted-foreground/80"
              strokeWidth={2}
            />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <VscodeEntryIcon
        pathValue={props.row.entry.path}
        kind={props.row.entry.kind}
        theme={props.resolvedTheme}
        className="size-[15px] shrink-0"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{props.row.name}</span>
      {props.searchMode && props.row.entry.parentPath ? (
        <span className="min-w-0 max-w-[34%] truncate text-[10px] text-muted-foreground/65">
          {props.row.entry.parentPath}
        </span>
      ) : null}
      {props.row.kind === "file" && props.gitStatus ? (
        <span
          className={cn(
            "shrink-0 text-[10px] font-semibold tracking-[0.08em]",
            gitDecorationClass(props.gitStatus),
          )}
        >
          {props.gitStatus}
        </span>
      ) : null}
    </button>
  );
}

function InlineExplorerRow(props: {
  depth: number;
  onCancel: () => void;
  onChangeValue: (value: string) => void;
  onCommit: () => void;
  resolvedTheme: "light" | "dark";
  searchMode: boolean;
  state: ExplorerInlineEntryState;
}) {
  const inputElementRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      inputElementRef.current?.focus();
      inputElementRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className={cn(WORKSPACE_EXPLORER_ROW_CLASS, WORKSPACE_EXPLORER_SELECTED_ROW_CLASS)}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.depth * 10}px`,
      }}
    >
      <span className="size-3.5 shrink-0" />
      <VscodeEntryIcon
        pathValue={pathForInlineEntryIcon(props.state)}
        kind={props.state.kind === "create-folder" ? "directory" : "file"}
        theme={props.resolvedTheme}
        className="size-[15px]"
      />
      <Input
        ref={inputElementRef}
        value={props.state.value}
        onChange={(event) => props.onChangeValue(event.target.value)}
        onBlur={() => {
          if (props.state.value.trim().length === 0) {
            props.onCancel();
            return;
          }
          props.onCommit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onCommit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
        className={cn(APP_SETTINGS_FIELD_CLASS_NAME, "h-6 rounded-md px-1.5")}
        size="sm"
      />
    </div>
  );
}

function useThreadWorkspaceEditorComponent(inputProps: {
  availableEditors: ReadonlyArray<EditorId>;
  branch?: string | null;
  browserOpen: boolean;
  connectionUrl?: string | null | undefined;
  gitCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  lspCwd?: string | null;
  detachEnabled?: boolean;
  detachedReturnPlacement?: "bottom" | "right" | "workspace";
  editorStateInstanceId?: string | null | undefined;
  onDetached?: () => void;
  onReturnToMainWindow?: () => void;
  terminalOpen: boolean;
  threadId: ThreadId;
  worktreePath?: string | null;
  workspaceMode?: ThreadWorkspaceMode | undefined;
  onSubmitAgentNote?: (input: WorkspaceAgentNoteSubmission) => Promise<boolean> | boolean;
}) {
  const reactEditorStateInstanceId = useId();
  const fallbackEditorStateInstanceId = `surface-${resolveEditorWindowStateInstanceId()}-${reactEditorStateInstanceId}`;
  const inputEditorStateInstanceId =
    typeof inputProps.editorStateInstanceId === "string"
      ? inputProps.editorStateInstanceId.trim() || undefined
      : undefined;
  const editorStateInstanceId = inputEditorStateInstanceId ?? fallbackEditorStateInstanceId;
  const editorStateScopeId = resolveEditorInstanceStateScopeId({
    gitCwd: inputProps.gitCwd,
    instanceId: editorStateInstanceId,
    threadId: inputProps.threadId,
  });
  const agentNoteThreadId = inputProps.threadId;
  const props = { ...inputProps, threadId: editorStateScopeId as ThreadId };
  const detachedEditorConnectionUrl = inputProps.connectionUrl;
  const detachedEditorThreadId = inputProps.threadId;
  const detachedEditorStateInstanceId = editorStateInstanceId;
  const detachedReturnPlacement = inputProps.detachedReturnPlacement;
  const detachedWorkspaceMode =
    detachedReturnPlacement === "workspace" &&
    (inputProps.workspaceMode === "editor" || inputProps.workspaceMode === "split")
      ? inputProps.workspaceMode
      : undefined;
  const onEditorDetached = inputProps.onDetached;
  const onReturnToMainWindow = inputProps.onReturnToMainWindow;
  const canDetachEditor =
    inputProps.detachEnabled !== false && Boolean(window.desktopBridge?.openDetachedEditor);
  const detachEditor = async () => {
    const openDetachedEditor = window.desktopBridge?.openDetachedEditor;
    if (!openDetachedEditor) {
      return;
    }
    const detached = await openDetachedEditor({
      threadId: detachedEditorThreadId,
      ...(detachedEditorConnectionUrl ? { connectionUrl: detachedEditorConnectionUrl } : {}),
      ...(detachedEditorStateInstanceId
        ? { editorStateInstanceId: detachedEditorStateInstanceId }
        : {}),
      ...(detachedReturnPlacement ? { placement: detachedReturnPlacement } : {}),
      ...(detachedWorkspaceMode ? { workspaceMode: detachedWorkspaceMode } : {}),
    });
    if (detached) {
      onEditorDetached?.();
      return;
    }
    toastManager.add({
      title: "Could not detach editor",
      description: "The desktop app did not open a detached editor window.",
      type: "error",
    });
  };

  const { resolvedTheme } = useTheme();
  const { updateSettings } = useUpdateSettings();
  const editorLineNumbers = useSetting("editorLineNumbers");
  const editorRenderWhitespace = useSetting("editorRenderWhitespace");
  const editorStickyScroll = useSetting("editorStickyScroll");
  const editorWordWrap = useSetting("editorWordWrap");
  const editorSettings = {
    lineNumbers: editorLineNumbers,
    renderWhitespace: editorRenderWhitespace,
    stickyScroll: editorStickyScroll,
    wordWrap: editorWordWrap,
  };
  const queryClient = useQueryClient();
  const api = readNativeApi();
  const [recentCodeSearches, setRecentCodeSearches] = useLocalStorage(
    WORKSPACE_CODE_SEARCH_RECENTS_STORAGE_KEY,
    [],
    WorkspaceCodeSearchRecentsSchema,
  );
  const [uiState, dispatchUiState] = useReducer(
    threadWorkspaceEditorUiStateReducer,
    EMPTY_THREAD_WORKSPACE_EDITOR_UI_STATE,
  );
  const {
    treeSearch,
    codeSearchQuery,
    sidebarMode,
    commandPaletteOpen,
    commandPaletteMode,
    queuedWorkspaceContexts,
    agentNoteSubmissionBusy,
    selectedEntryPath,
    inlineEntryState,
    dragTargetParentPath,
    saveConflict,
    selectedReviewFilePath,
    problemReportsByPaneId,
    symbolReportsByPaneId,
    problemNavigationTarget,
    symbolNavigationTarget,
    findRequestToken,
    collapsedOutlineIds,
    activeOutlineSymbolId,
  } = uiState;
  const setTreeSearch = (treeSearch: string) => {
    dispatchUiState({ type: "set-tree-search", treeSearch });
  };
  const setCodeSearchQuery = (codeSearchQuery: string) => {
    dispatchUiState({ type: "set-code-search-query", codeSearchQuery });
  };
  const handleCodeSearchExampleClick = (query: string) => {
    dispatchUiState({ type: "set-code-search-query", codeSearchQuery: query });
  };
  const setSidebarMode = (sidebarMode: WorkspaceSidebarMode) => {
    dispatchUiState({ type: "set-sidebar-mode", sidebarMode });
  };
  const setSelectedReviewFilePath = useCallback((selectedReviewFilePath: string | null) => {
    dispatchUiState({ type: "set-selected-review-file-path", selectedReviewFilePath });
  }, []);
  const setCommandPaletteOpen = (commandPaletteOpen: boolean) => {
    dispatchUiState({ type: "set-command-palette-open", commandPaletteOpen });
  };
  const setCommandPaletteMode = (commandPaletteMode: WorkspaceCommandPaletteMode) => {
    dispatchUiState({ type: "set-command-palette-mode", commandPaletteMode });
  };
  const setQueuedWorkspaceContexts = (
    nextQueuedWorkspaceContexts:
      | readonly QueuedWorkspaceContext[]
      | ((current: readonly QueuedWorkspaceContext[]) => readonly QueuedWorkspaceContext[]),
  ) => {
    dispatchUiState({ type: "set-queued-workspace-contexts", nextQueuedWorkspaceContexts });
  };
  const setAgentNoteSubmissionBusy = (agentNoteSubmissionBusy: boolean) => {
    dispatchUiState({ type: "set-agent-note-submission-busy", agentNoteSubmissionBusy });
  };
  const setSelectedEntryPath = useCallback((selectedEntryPath: string | null) => {
    dispatchUiState({ type: "set-selected-entry-path", selectedEntryPath });
  }, []);
  const setInlineEntryState = (
    inlineEntryState:
      | ExplorerInlineEntryState
      | null
      | ((current: ExplorerInlineEntryState | null) => ExplorerInlineEntryState | null),
  ) => {
    dispatchUiState({ type: "set-inline-entry-state", inlineEntryState });
  };
  const setDragTargetParentPath = (dragTargetParentPath: string | null) => {
    dispatchUiState({ type: "set-drag-target-parent-path", dragTargetParentPath });
  };
  const setSaveConflict = (
    saveConflict:
      | SaveConflictState
      | null
      | ((current: SaveConflictState | null) => SaveConflictState | null),
  ) => {
    dispatchUiState({ type: "set-save-conflict", saveConflict });
  };
  const setProblemReportsByPaneId = (
    nextProblemReportsByPaneId:
      | Record<
          string,
          { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
        >
      | ((
          current: Record<
            string,
            { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
          >,
        ) => Record<
          string,
          { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
        >),
  ) => {
    dispatchUiState({ type: "set-problem-reports-by-pane-id", nextProblemReportsByPaneId });
  };
  const setSymbolReportsByPaneId = (
    nextSymbolReportsByPaneId:
      | Record<
          string,
          { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
        >
      | ((
          current: Record<
            string,
            { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
          >,
        ) => Record<
          string,
          { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }
        >),
  ) => {
    dispatchUiState({ type: "set-symbol-reports-by-pane-id", nextSymbolReportsByPaneId });
  };
  const setProblemNavigationTarget = (
    problemNavigationTarget: WorkspaceEditorProblemNavigationTarget | null,
  ) => {
    dispatchUiState({ type: "set-problem-navigation-target", problemNavigationTarget });
  };
  const setSymbolNavigationTarget = useCallback(
    (symbolNavigationTarget: WorkspaceEditorSymbolNavigationTarget | null) => {
      dispatchUiState({ type: "set-symbol-navigation-target", symbolNavigationTarget });
    },
    [],
  );
  const bumpFindRequestToken = useCallback(() => {
    dispatchUiState({ type: "bump-find-request-token" });
  }, []);
  const setCollapsedOutlineIds = (
    nextCollapsedOutlineIds:
      | ReadonlySet<string>
      | ((current: ReadonlySet<string>) => ReadonlySet<string>),
  ) => {
    dispatchUiState({ type: "set-collapsed-outline-ids", nextCollapsedOutlineIds });
  };
  const setActiveOutlineSymbolId = (
    activeOutlineSymbolId: string | null | ((current: string | null) => string | null),
  ) => {
    dispatchUiState({ type: "set-active-outline-symbol-id", activeOutlineSymbolId });
  };
  const deferredTreeSearch = useDeferredValue(treeSearch.trim());
  const trimmedCodeSearchQuery = codeSearchQuery.trim();
  const [debouncedCodeSearchQuery, codeSearchDebouncer] = useDebouncedValue(
    trimmedCodeSearchQuery,
    { wait: WORKSPACE_CODE_SEARCH_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const treeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const editorGridRef = useRef<HTMLDivElement | null>(null);
  const rowGroupRefs = useRef<Map<string, HTMLDivElement | null>>(null!);
  if (rowGroupRefs.current === null) {
    rowGroupRefs.current = new Map<string, HTMLDivElement | null>();
  }
  const pendingExplorerRevealPathRef = useRef<string | null>(null);
  const closeFile = useEditorStateStore((state) => state.closeFile);
  const closeFilesToRight = useEditorStateStore((state) => state.closeFilesToRight);
  const closeOtherFiles = useEditorStateStore((state) => state.closeOtherFiles);
  const closePane = useEditorStateStore((state) => state.closePane);
  const discardDraft = useEditorStateStore((state) => state.discardDraft);
  const expandDirectories = useEditorStateStore((state) => state.expandDirectories);
  const hydrateFile = useEditorStateStore((state) => state.hydrateFile);
  const markFileSaved = useEditorStateStore((state) => state.markFileSaved);
  const moveFile = useEditorStateStore((state) => state.moveFile);
  const openFile = useEditorStateStore((state) => state.openFile);
  const removeEntry = useEditorStateStore((state) => state.removeEntry);
  const renameEntry = useEditorStateStore((state) => state.renameEntry);
  const reopenClosedFile = useEditorStateStore((state) => state.reopenClosedFile);
  const setActiveFile = useEditorStateStore((state) => state.setActiveFile);
  const setActivePane = useEditorStateStore((state) => state.setActivePane);
  const setExplorerOpen = useEditorStateStore((state) => state.setExplorerOpen);
  const setPaneRatios = useEditorStateStore((state) => state.setPaneRatios);
  const setRowRatios = useEditorStateStore((state) => state.setRowRatios);
  const setTreeWidth = useEditorStateStore((state) => state.setTreeWidth);
  const splitPane = useEditorStateStore((state) => state.splitPane);
  const syncTree = useEditorStateStore((state) => state.syncTree);
  const toggleDirectory = useEditorStateStore((state) => state.toggleDirectory);
  const updateDraft = useEditorStateStore((state) => state.updateDraft);
  const addCodeComment = useEditorStateStore((state) => state.addCodeComment);
  const removeCodeComment = useEditorStateStore((state) => state.removeCodeComment);
  const updateCodeCommentStatus = useEditorStateStore((state) => state.updateCodeCommentStatus);
  const hasRecentlyClosedFiles = useEditorStateStore(
    (state) =>
      (state.runtimeStateByThreadId[props.threadId]?.recentlyClosedEntries.length ?? 0) > 0,
  );
  const editorState = useEditorStateStore((state) =>
    selectThreadEditorState(
      state.threadStateByThreadId,
      state.runtimeStateByThreadId,
      props.threadId,
    ),
  );
  const {
    activePaneId,
    codeComments,
    draftsByFilePath,
    expandedDirectoryPaths,
    explorerOpen,
    paneRatios,
    panes,
    rows,
    treeWidth,
  } = editorState;
  const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null;
  const workspaceProblems = Object.entries(problemReportsByPaneId)
    .flatMap(([paneId, report]) =>
      report.activeFilePath
        ? report.problems.map((problem) => ({
            paneId,
            problem,
            relativePath: report.activeFilePath!,
          }))
        : [],
    )
    .toSorted((left, right) => {
      const severityDelta =
        problemSeverityRank(right.problem.severity) - problemSeverityRank(left.problem.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }
      const pathDelta = left.relativePath.localeCompare(right.relativePath);
      if (pathDelta !== 0) {
        return pathDelta;
      }
      if (left.problem.startLineNumber !== right.problem.startLineNumber) {
        return left.problem.startLineNumber - right.problem.startLineNumber;
      }
      return left.problem.startColumn - right.problem.startColumn;
    });
  const workspaceSymbols: readonly WorkspaceSymbolReport[] = Object.entries(symbolReportsByPaneId)
    .flatMap(([paneId, report]) =>
      report.activeFilePath
        ? report.symbols.map((symbol) => ({
            paneId,
            relativePath: report.activeFilePath!,
            symbol,
          }))
        : [],
    )
    .toSorted((left, right) => {
      const pathDelta = left.relativePath.localeCompare(right.relativePath);
      if (pathDelta !== 0) {
        return pathDelta;
      }
      if (left.symbol.startLineNumber !== right.symbol.startLineNumber) {
        return left.symbol.startLineNumber - right.symbol.startLineNumber;
      }
      return left.symbol.startColumn - right.symbol.startColumn;
    });
  const outlineFileGroups: readonly WorkspaceOutlineFileGroup[] = (() => {
    const symbolsByPath = new Map<string, WorkspaceSymbolReport[]>();
    for (const report of workspaceSymbols) {
      const existing = symbolsByPath.get(report.relativePath);
      if (existing) {
        existing.push(report);
      } else {
        symbolsByPath.set(report.relativePath, [report]);
      }
    }

    return Array.from(symbolsByPath.entries()).map(([relativePath, reports]) => {
      const baseDepth = reports.reduce(
        (minimum, report) => Math.min(minimum, report.symbol.depth),
        Number.POSITIVE_INFINITY,
      );
      const normalizedBaseDepth = Number.isFinite(baseDepth) ? baseDepth : 0;
      const stack: number[] = [];
      const nodes: Array<{
        depth: number;
        hasChildren: boolean;
        id: string;
        report: WorkspaceSymbolReport;
      }> = [];
      for (const [index, report] of reports.entries()) {
        const depth = Math.max(0, report.symbol.depth - normalizedBaseDepth);
        while (stack.length > depth) {
          stack.pop();
        }
        const parentIndex = depth > 0 ? stack[depth - 1] : undefined;
        nodes.push({
          depth,
          hasChildren: false,
          id: workspaceSymbolNodeId(report),
          report,
        });
        if (parentIndex !== undefined) {
          const parent = nodes[parentIndex];
          if (parent) {
            parent.hasChildren = true;
          }
        }
        stack[depth] = index;
        stack.length = depth + 1;
      }

      return {
        id: `file:${relativePath}`,
        relativePath,
        symbolCount: nodes.length,
        symbols: nodes,
      };
    });
  })();
  const visibleOutlineGroups = outlineFileGroups.map((group) => {
    if (collapsedOutlineIds.has(group.id)) {
      return { ...group, symbols: [] };
    }
    const visibleSymbols: WorkspaceOutlineSymbolNode[] = [];
    let hiddenDepth: number | null = null;
    for (const node of group.symbols) {
      if (hiddenDepth !== null) {
        if (node.depth > hiddenDepth) {
          continue;
        }
        hiddenDepth = null;
      }
      visibleSymbols.push(node);
      if (node.hasChildren && collapsedOutlineIds.has(node.id)) {
        hiddenDepth = node.depth;
      }
    }
    return { ...group, symbols: visibleSymbols };
  });
  useEffect(() => {
    const validIds = new Set<string>();
    for (const group of outlineFileGroups) {
      validIds.add(group.id);
      for (const node of group.symbols) {
        validIds.add(node.id);
      }
    }
    setCollapsedOutlineIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setActiveOutlineSymbolId((current) => {
      if (!current || validIds.has(current)) {
        return current;
      }
      return null;
    });
  }, [outlineFileGroups]);
  useEffect(() => {
    const paneIds = new Set(panes.map((pane) => pane.id));
    setProblemReportsByPaneId((current) => {
      const nextEntries = Object.entries(current).filter(([paneId]) => paneIds.has(paneId));
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
    setSymbolReportsByPaneId((current) => {
      const nextEntries = Object.entries(current).filter(([paneId]) => paneIds.has(paneId));
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [panes]);
  const revealEntryLabel = revealInFileManagerLabel();
  const revealWorkspaceLabel = (() => {
    if (revealEntryLabel === "Reveal in Finder") {
      return "Reveal Workspace in Finder";
    }
    if (revealEntryLabel === "Reveal in Explorer") {
      return "Reveal Workspace in Explorer";
    }
    return "Reveal Workspace in File Manager";
  })();
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane] as const)), [panes]);
  const diagnosticsCwd = props.gitCwd ?? props.lspCwd ?? null;
  const openWorkspaceFilePaths = Array.from(
    new Set(panes.flatMap((pane) => pane.openFilePaths)),
  ).toSorted();
  const previousWorkspaceBufferStateRef = useRef<{
    cwd: string | null;
    filePaths: ReadonlySet<string>;
  }>({
    cwd: null,
    filePaths: new Set<string>(),
  });
  const editorOptions = createWorkspaceEditorOptions(editorSettings);
  const diffEditorOptions = createWorkspaceDiffEditorOptions();
  const fileEventsConnected = Boolean(api && props.gitCwd);
  useEffect(() => {
    const previous = previousWorkspaceBufferStateRef.current;
    const nextFilePaths = new Set(openWorkspaceFilePaths);
    const removedFilePaths =
      previous.cwd && previous.cwd !== diagnosticsCwd
        ? Array.from(previous.filePaths)
        : previous.cwd
          ? Array.from(previous.filePaths).filter((filePath) => !nextFilePaths.has(filePath))
          : [];

    if (api && previous.cwd && removedFilePaths.length > 0) {
      const previousCwd = previous.cwd;
      void Promise.allSettled(
        removedFilePaths.map((relativePath) =>
          api.workspaceEditor.closeBuffer(
            withRpcRouteConnection(
              {
                cwd: previousCwd,
                relativePath,
              },
              inputProps.connectionUrl,
            ),
          ),
        ),
      ).then((results) => {
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            console.error("Failed to close workspace editor buffer", {
              cwd: previousCwd,
              relativePath: removedFilePaths[index],
              error: result.reason,
            });
          }
        }
      });
    }

    previousWorkspaceBufferStateRef.current = {
      cwd: diagnosticsCwd,
      filePaths: nextFilePaths,
    };
  }, [api, diagnosticsCwd, inputProps.connectionUrl, openWorkspaceFilePaths]);

  useEffect(
    () => () => {
      const previous = previousWorkspaceBufferStateRef.current;
      if (!api || !previous.cwd || previous.filePaths.size === 0) {
        return;
      }
      const previousCwd = previous.cwd;
      void Promise.allSettled(
        Array.from(previous.filePaths).map((relativePath) =>
          api.workspaceEditor.closeBuffer(
            withRpcRouteConnection(
              {
                cwd: previousCwd,
                relativePath,
              },
              inputProps.connectionUrl,
            ),
          ),
        ),
      );
    },
    [api, inputProps.connectionUrl],
  );

  const {
    data: workspaceTreeData,
    isFetching: isWorkspaceTreeFetching,
    isPending: isWorkspaceTreePending,
  } = useQuery({
    ...projectListTreeQueryOptions({
      connectionUrl: inputProps.connectionUrl,
      cwd: props.gitCwd,
      refetchInterval: WORKSPACE_TREE_REFETCH_INTERVAL_MS,
    }),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const { data: gitStatusData } = useQuery(
    gitStatusQueryOptions(props.gitCwd, inputProps.connectionUrl),
  );
  const searchMode = deferredTreeSearch.length > 0;
  const treeEntries = workspaceTreeData?.entries ?? EMPTY_PROJECT_ENTRIES;
  const localSearchEntries = searchMode
    ? searchWorkspaceEntriesLocally(treeEntries, deferredTreeSearch)
    : EMPTY_PROJECT_ENTRIES;
  const searchEntries = localSearchEntries.slice(0, WORKSPACE_SEARCH_RESULT_LIMIT);
  const searchableFileEntries = treeEntries.filter((candidate) => candidate.kind === "file");
  const entryByPath = new Map(treeEntries.map((entry) => [entry.path, entry] as const));
  const {
    data: codeSearchResultsData,
    isError: isCodeSearchResultsError,
    isFetching: isCodeSearchResultsFetching,
    isPending: isCodeSearchResultsPending,
  } = useQuery({
    queryKey: [
      "workspace",
      "code-search",
      inputProps.connectionUrl ?? null,
      props.gitCwd,
      debouncedCodeSearchQuery,
    ],
    queryFn: async ({ signal }): Promise<readonly WorkspaceCodeSearchResult[]> => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace code search is unavailable.");
      }

      const searchQueries = buildWorkspaceCodeSearchQueries(debouncedCodeSearchQuery);
      const candidateEntriesByPath = new Map<string, ProjectEntry>();
      for (const entry of searchWorkspaceEntriesLocally(
        searchableFileEntries,
        debouncedCodeSearchQuery,
        { limit: WORKSPACE_CODE_SEARCH_LOCAL_CANDIDATE_LIMIT },
      )) {
        candidateEntriesByPath.set(entry.path, entry);
      }

      signal.throwIfAborted();
      const remoteResults = await Promise.all(
        searchQueries.map((query) =>
          api.projects
            .searchEntries(
              withRpcRouteConnection(
                {
                  cwd: props.gitCwd!,
                  limit: WORKSPACE_CODE_SEARCH_REMOTE_LIMIT,
                  query,
                },
                inputProps.connectionUrl,
              ),
            )
            .catch(() => ({ entries: [], truncated: false })),
        ),
      );
      signal.throwIfAborted();

      for (const result of remoteResults) {
        for (const entry of result.entries) {
          if (entry.kind === "file") {
            candidateEntriesByPath.set(entry.path, entry);
          }
        }
      }

      const candidateEntries = Array.from(candidateEntriesByPath.values()).slice(
        0,
        WORKSPACE_CODE_SEARCH_MAX_CANDIDATE_FILES,
      );
      signal.throwIfAborted();
      const candidateFiles = await Promise.all(
        candidateEntries.map((entry) =>
          api.projects
            .readFile(
              withRpcRouteConnection(
                {
                  cwd: props.gitCwd!,
                  relativePath: entry.path,
                },
                inputProps.connectionUrl,
              ),
            )
            .then((file) => ({ entry, file }))
            .catch(() => null),
        ),
      );
      signal.throwIfAborted();

      const results: WorkspaceCodeSearchResult[] = [];
      for (const candidateFile of candidateFiles) {
        if (!candidateFile) {
          continue;
        }
        const result = createWorkspaceCodeSearchResult({
          contents: candidateFile.file.contents,
          entry: candidateFile.entry,
          query: debouncedCodeSearchQuery,
        });
        if (result) {
          results.push(result);
        }
      }

      return sortWorkspaceCodeSearchResults(results).slice(0, 80);
    },
    enabled:
      sidebarMode === "search" &&
      Boolean(api) &&
      props.gitCwd !== null &&
      debouncedCodeSearchQuery.length >= 2,
    staleTime: 20_000,
    placeholderData: (previous) => previous ?? [],
  });
  const codeSearchResultGroups = groupWorkspaceCodeSearchResults(codeSearchResultsData ?? []);
  const codeSearchResultPathSet = new Set(
    (codeSearchResultsData ?? []).map((result) => result.entry.path),
  );
  const codeSearchFileResults =
    debouncedCodeSearchQuery.length >= 2
      ? searchWorkspaceEntriesLocally(searchableFileEntries, debouncedCodeSearchQuery, {
          limit: WORKSPACE_CODE_SEARCH_PATH_RESULT_LIMIT,
        }).filter((entry) => !codeSearchResultPathSet.has(entry.path))
      : EMPTY_PROJECT_ENTRIES;
  const codeSearchResultCount = codeSearchFileResults.length + (codeSearchResultsData?.length ?? 0);
  const codeSearchBusy =
    (trimmedCodeSearchQuery.length >= 2 &&
      codeSearchDebouncer.state.isPending &&
      trimmedCodeSearchQuery !== debouncedCodeSearchQuery) ||
    isCodeSearchResultsPending ||
    isCodeSearchResultsFetching;
  const visibleRecentCodeSearches = (() => {
    const seenQueries = new Set<string>();
    const visibleQueries: string[] = [];
    for (const query of recentCodeSearches) {
      const trimmedQuery = query.trim();
      const normalizedQuery = trimmedQuery.toLowerCase();
      if (trimmedQuery.length < 2 || seenQueries.has(normalizedQuery)) {
        continue;
      }
      seenQueries.add(normalizedQuery);
      visibleQueries.push(trimmedQuery);
      if (visibleQueries.length >= WORKSPACE_CODE_SEARCH_RECENT_LIMIT) {
        break;
      }
    }
    return visibleQueries;
  })();

  useEffect(() => {
    if (
      sidebarMode !== "search" ||
      debouncedCodeSearchQuery.length < 2 ||
      codeSearchBusy ||
      codeSearchResultCount === 0
    ) {
      return;
    }

    setRecentCodeSearches((current) => {
      const nextQuery = debouncedCodeSearchQuery.trim();
      if (nextQuery.length < 2) {
        return current;
      }
      const next = [
        nextQuery,
        ...current.filter((query) => query.trim().toLowerCase() !== nextQuery.toLowerCase()),
      ].slice(0, WORKSPACE_CODE_SEARCH_RECENT_LIMIT);
      return next.length === current.length &&
        next.every((query, index) => query === current[index])
        ? current
        : next;
    });
  }, [
    codeSearchBusy,
    codeSearchResultCount,
    debouncedCodeSearchQuery,
    setRecentCodeSearches,
    sidebarMode,
  ]);

  useEffect(() => {
    if (treeEntries.length === 0) {
      return;
    }
    syncTree(
      props.threadId,
      treeEntries.map((entry) => entry.path),
    );
  }, [props.threadId, syncTree, treeEntries]);

  const saveMutation = useMutation({
    mutationFn: async (input: {
      contents: string;
      expectedVersion?: string;
      overwrite?: boolean;
      relativePath: string;
    }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.writeFile({
        ...withRpcRouteConnection(
          {
            contents: input.contents,
            cwd: props.gitCwd,
            expectedVersion: input.expectedVersion,
            overwrite: input.overwrite,
            relativePath: input.relativePath,
          },
          inputProps.connectionUrl,
        ),
      });
    },
    onError: (error, variables) => {
      const conflict = parseSaveConflictState(error, variables);
      if (conflict) {
        setSaveConflict(conflict);
        return;
      }
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to save ${variables.relativePath}.`,
        title: "Could not save file",
        type: "error",
      });
    },
    onSuccess: (result, variables) => {
      setSaveConflict((current) =>
        current?.relativePath === variables.relativePath ? null : current,
      );
      markFileSaved(props.threadId, variables.relativePath, variables.contents);
      queryClient.setQueryData(
        projectQueryKeys.readFile(props.gitCwd, variables.relativePath, inputProps.connectionUrl),
        {
          contents: variables.contents,
          relativePath: variables.relativePath,
          sizeBytes: new Blob([variables.contents]).size,
          version: result.version,
        },
      );
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
      });
    },
  });

  const handleSaveFile = (relativePath: string, contents: string) => {
    if (saveMutation.isPending) {
      return;
    }
    const readFileCache = queryClient.getQueryData<ProjectReadFileResult>(
      projectQueryKeys.readFile(props.gitCwd, relativePath, inputProps.connectionUrl),
    );
    const payload: {
      contents: string;
      expectedVersion?: string;
      relativePath: string;
    } = {
      contents,
      relativePath,
    };
    if (typeof readFileCache?.version === "string") {
      payload.expectedVersion = readFileCache.version;
    }
    void saveMutation.mutate(payload);
  };
  const handleOverwriteSaveConflict = () => {
    if (!saveConflict || saveMutation.isPending) {
      return;
    }
    const payload: {
      contents: string;
      expectedVersion?: string;
      overwrite: boolean;
      relativePath: string;
    } = {
      contents: saveConflict.localContents,
      overwrite: true,
      relativePath: saveConflict.relativePath,
    };
    if (saveConflict.currentVersion) {
      payload.expectedVersion = saveConflict.currentVersion;
    }
    void saveMutation.mutate(payload);
  };
  const handleUseDiskVersion = () => {
    if (!saveConflict) {
      return;
    }
    markFileSaved(props.threadId, saveConflict.relativePath, saveConflict.currentContents);
    if (saveConflict.currentVersion) {
      queryClient.setQueryData(
        projectQueryKeys.readFile(
          props.gitCwd,
          saveConflict.relativePath,
          inputProps.connectionUrl,
        ),
        {
          contents: saveConflict.currentContents,
          relativePath: saveConflict.relativePath,
          sizeBytes: new Blob([saveConflict.currentContents]).size,
          version: saveConflict.currentVersion,
        },
      );
    } else {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.readFile(
          props.gitCwd,
          saveConflict.relativePath,
          inputProps.connectionUrl,
        ),
      });
    }
    setSaveConflict(null);
  };
  const handleHydrateFile = (filePath: string, contents: string) => {
    hydrateFile(props.threadId, filePath, contents);
  };

  const normalizedRowRatios = normalizePaneRatios(paneRatios, rows.length);
  const layoutRows = (() => {
    const nextRows: Array<ThreadEditorRowState & { panes: typeof panes }> = [];
    for (const row of rows) {
      const rowPanes: typeof panes = [];
      for (const paneId of row.paneIds) {
        const pane = panesById.get(paneId);
        if (pane) {
          rowPanes.push(pane);
        }
      }
      if (rowPanes.length > 0) {
        nextRows.push({
          ...row,
          paneRatios: normalizePaneRatios(row.paneRatios, rowPanes.length),
          panes: rowPanes,
        });
      }
    }
    return nextRows;
  })();
  const orderedPaneIds = layoutRows.flatMap((row) => row.paneIds);

  const activeDirtyPaths = Object.entries(draftsByFilePath).reduce<Set<string>>(
    (paths, [path, draft]) => {
      if (draft.draftContents !== draft.savedContents) {
        paths.add(path);
      }
      return paths;
    },
    new Set<string>(),
  );
  const activeDirtyPathsRef = useRef(activeDirtyPaths);

  useEffect(() => {
    activeDirtyPathsRef.current = activeDirtyPaths;
  }, [activeDirtyPaths]);

  const getCachedReadFileResult = useCallback(
    (filePath: string): ProjectReadFileResult | null => {
      if (!props.gitCwd) {
        return null;
      }
      return (
        queryClient.getQueryData<ProjectReadFileResult>(
          projectQueryKeys.readFile(props.gitCwd, filePath, inputProps.connectionUrl),
        ) ?? null
      );
    },
    [inputProps.connectionUrl, props.gitCwd, queryClient],
  );

  const hydrateFileFromReadCache = useCallback(
    (filePath: string): boolean => {
      const cached = getCachedReadFileResult(filePath);
      if (!cached) {
        return false;
      }
      hydrateFile(props.threadId, filePath, cached.contents);
      return true;
    },
    [getCachedReadFileResult, hydrateFile, props.threadId],
  );

  const prefetchWorkspaceEditorFile = useCallback(
    (filePath: string): Promise<unknown> | undefined => {
      if (
        !props.gitCwd ||
        activeDirtyPathsRef.current.has(filePath) ||
        !shouldPrefetchWorkspaceEditorFile(filePath) ||
        getCachedReadFileResult(filePath)
      ) {
        return undefined;
      }
      return queryClient
        .prefetchQuery(
          projectReadFileQueryOptions({
            connectionUrl: inputProps.connectionUrl,
            cwd: props.gitCwd,
            relativePath: filePath,
            refetchInterval: false,
          }),
        )
        .catch(() => undefined);
    },
    [getCachedReadFileResult, inputProps.connectionUrl, props.gitCwd, queryClient],
  );

  const prepareWorkspaceFileOpen = useCallback(
    (filePath: string) => {
      hydrateFileFromReadCache(filePath);
      void prefetchWorkspaceEditorFile(filePath);
    },
    [hydrateFileFromReadCache, prefetchWorkspaceEditorFile],
  );

  useEffect(() => {
    if (!api || !props.gitCwd) {
      return;
    }
    const unsubscribe = api.projects.onFileEvents(
      withRpcRouteConnection({ cwd: props.gitCwd }, inputProps.connectionUrl),
      (event) => {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
        });
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const queryKey = query.queryKey;
            return (
              queryKey[0] === "projects" &&
              queryKey[1] === "search-entries" &&
              queryKey[2] === (inputProps.connectionUrl ?? null) &&
              queryKey[3] === props.gitCwd
            );
          },
        });

        if (event.overflowed) {
          return;
        }
        for (const relativePath of event.relativePaths) {
          if (activeDirtyPathsRef.current.has(relativePath)) {
            continue;
          }
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.readFile(
              props.gitCwd,
              relativePath,
              inputProps.connectionUrl,
            ),
            exact: true,
          });
        }
      },
    );
    return () => {
      unsubscribe();
    };
  }, [api, inputProps.connectionUrl, props.gitCwd, queryClient]);

  useEffect(() => {
    if (!api || !props.gitCwd || openWorkspaceFilePaths.length === 0) {
      return;
    }

    const prefetchFilePaths = openWorkspaceFilePaths.filter(
      (filePath) =>
        shouldPrefetchWorkspaceEditorFile(filePath) && !activeDirtyPathsRef.current.has(filePath),
    );
    if (prefetchFilePaths.length === 0) {
      return;
    }

    let cancelled = false;
    const prefetchOpenFiles = async () => {
      if (cancelled) {
        return;
      }
      await Promise.all(
        prefetchFilePaths.map((relativePath) => prefetchWorkspaceEditorFile(relativePath)),
      );
    };

    void prefetchOpenFiles();
    return () => {
      cancelled = true;
    };
  }, [api, openWorkspaceFilePaths, prefetchWorkspaceEditorFile, props.gitCwd]);

  const gitStatusByPath = (() => {
    const files = gitStatusData?.workingTree.files ?? [];
    const statusByPath = new Map<string, GitWorkingTreeFileStatus>();
    for (const file of files) {
      if (file.status) {
        statusByPath.set(file.path, file.status);
      }
    }
    return statusByPath;
  })();
  const changedFiles = gitStatusData?.workingTree.files ?? [];
  const openCodeCommentCount = countOpenWorkspaceCodeComments(codeComments);
  const unresolvedCodeComments = codeComments.filter((comment) => comment.status !== "resolved");
  const queueWorkspaceSelectionContext = (context: WorkspaceSelectionContext, prompt: string) => {
    const id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `selection-${Date.now().toString(36)}`;
    setQueuedWorkspaceContexts((current) => [
      ...current,
      {
        context,
        createdAt: new Date().toISOString(),
        id,
        prompt,
      },
    ]);
    setSidebarMode("review");
    setExplorerOpen(props.threadId, true);
    toastManager.add({
      description: `${context.relativePath}:${context.range.startLine + 1}-${context.range.endLine + 1}`,
      title: "Editor context queued",
      type: "success",
    });
  };
  const queueWorkspaceFileContext = (relativePath: string, prompt: string) => {
    const cwd = props.gitCwd ?? props.lspCwd;
    if (!cwd) {
      return;
    }
    queueWorkspaceSelectionContext(
      {
        cwd,
        diagnostics: [],
        kind: "workspace-selection",
        languageId: resolveWorkspaceLanguageFromFilePath(relativePath) ?? null,
        range: {
          relativePath,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 0,
        },
        relativePath,
        text: "",
      },
      prompt,
    );
  };
  const handlePaneProblemsChange = (
    paneId: string,
    activeFilePath: string | null,
    problems: readonly WorkspaceEditorPaneProblem[],
  ) => {
    setProblemReportsByPaneId((current) => {
      const previous = current[paneId];
      let hasSameProblems = previous?.activeFilePath === activeFilePath;
      if (hasSameProblems) {
        const previousProblems = previous?.problems ?? [];
        hasSameProblems = previousProblems.length === problems.length;
        if (hasSameProblems) {
          for (const [index, problem] of previousProblems.entries()) {
            const next = problems[index];
            if (
              !next ||
              problem.message !== next.message ||
              problem.severity !== next.severity ||
              problem.startLineNumber !== next.startLineNumber ||
              problem.startColumn !== next.startColumn ||
              problem.endLineNumber !== next.endLineNumber ||
              problem.endColumn !== next.endColumn
            ) {
              hasSameProblems = false;
              break;
            }
          }
        }
      }
      if (hasSameProblems) {
        return current;
      }
      return {
        ...current,
        [paneId]: { activeFilePath, problems },
      };
    });
  };
  const handlePaneSymbolsChange = (
    paneId: string,
    activeFilePath: string | null,
    symbols: readonly WorkspaceEditorPaneSymbol[],
  ) => {
    setSymbolReportsByPaneId((current) => {
      const previous = current[paneId];
      let hasSameSymbols = previous?.activeFilePath === activeFilePath;
      if (hasSameSymbols) {
        const previousSymbols = previous?.symbols ?? [];
        hasSameSymbols = previousSymbols.length === symbols.length;
        if (hasSameSymbols) {
          for (const [index, symbol] of previousSymbols.entries()) {
            const next = symbols[index];
            if (
              !next ||
              symbol.name !== next.name ||
              symbol.kind !== next.kind ||
              symbol.startLineNumber !== next.startLineNumber ||
              symbol.startColumn !== next.startColumn ||
              symbol.endLineNumber !== next.endLineNumber ||
              symbol.endColumn !== next.endColumn ||
              symbol.depth !== next.depth
            ) {
              hasSameSymbols = false;
              break;
            }
          }
        }
      }
      if (hasSameSymbols) {
        return current;
      }
      return {
        ...current,
        [paneId]: { activeFilePath, symbols },
      };
    });
  };
  const handleOpenProblem = useCallback(
    (report: WorkspaceProblemReport) => {
      const targetPaneId = panesById.has(report.paneId) ? report.paneId : (activePane?.id ?? null);
      if (!targetPaneId) {
        return;
      }
      setSelectedReviewFilePath(null);
      setActivePane(props.threadId, targetPaneId);
      prepareWorkspaceFileOpen(report.relativePath);
      openFile(props.threadId, report.relativePath, targetPaneId);
      const location: WorkspaceEditorLocation = {
        relativePath: report.relativePath,
        startLine: Math.max(0, report.problem.startLineNumber - 1),
        startColumn: Math.max(0, report.problem.startColumn - 1),
        endLine: Math.max(0, report.problem.endLineNumber - 1),
        endColumn: Math.max(0, report.problem.endColumn - 1),
      };
      setProblemNavigationTarget({
        id: Date.now(),
        location,
      });
    },
    [
      activePane?.id,
      openFile,
      panesById,
      prepareWorkspaceFileOpen,
      props.threadId,
      setActivePane,
      setSelectedReviewFilePath,
    ],
  );
  const handleOpenSymbol = useCallback(
    (report: WorkspaceSymbolReport) => {
      setActiveOutlineSymbolId(workspaceSymbolNodeId(report));
      const targetPaneId = panesById.has(report.paneId) ? report.paneId : (activePane?.id ?? null);
      if (!targetPaneId) {
        return;
      }
      setSelectedReviewFilePath(null);
      setActivePane(props.threadId, targetPaneId);
      prepareWorkspaceFileOpen(report.relativePath);
      openFile(props.threadId, report.relativePath, targetPaneId);
      const location: WorkspaceEditorLocation = {
        relativePath: report.relativePath,
        startLine: Math.max(0, report.symbol.startLineNumber - 1),
        startColumn: Math.max(0, report.symbol.startColumn - 1),
        endLine: Math.max(0, report.symbol.endLineNumber - 1),
        endColumn: Math.max(0, report.symbol.endColumn - 1),
      };
      setSymbolNavigationTarget({
        id: Date.now(),
        location,
      });
    },
    [
      activePane?.id,
      openFile,
      panesById,
      prepareWorkspaceFileOpen,
      props.threadId,
      setActivePane,
      setSelectedReviewFilePath,
      setSymbolNavigationTarget,
    ],
  );
  const handleOpenCodeSearchResult = useCallback(
    (result: WorkspaceCodeSearchResult, lineNumber?: number) => {
      const targetPaneId = activePane?.id ?? panes[0]?.id;
      if (!targetPaneId) {
        return;
      }
      setSelectedReviewFilePath(null);
      setActivePane(props.threadId, targetPaneId);
      prepareWorkspaceFileOpen(result.entry.path);
      openFile(props.threadId, result.entry.path, targetPaneId);
      const line = Math.max(0, (lineNumber ?? result.snippets[0]?.lineNumber ?? 1) - 1);
      setSymbolNavigationTarget({
        id: Date.now(),
        location: {
          endColumn: 0,
          endLine: line,
          relativePath: result.entry.path,
          startColumn: 0,
          startLine: line,
        },
      });
    },
    [
      activePane?.id,
      openFile,
      panes,
      prepareWorkspaceFileOpen,
      props.threadId,
      setActivePane,
      setSelectedReviewFilePath,
      setSymbolNavigationTarget,
    ],
  );
  const handleOpenCodeSearchFileResult = (entry: ProjectEntry) => {
    const targetPaneId = activePane?.id ?? panes[0]?.id;
    if (!targetPaneId) {
      return;
    }
    setSelectedReviewFilePath(null);
    setActivePane(props.threadId, targetPaneId);
    prepareWorkspaceFileOpen(entry.path);
    openFile(props.threadId, entry.path, targetPaneId);
  };
  const toggleOutlineId = (id: string) => {
    setCollapsedOutlineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const handleAddCodeComment = (comment: WorkspaceCodeComment) => {
    addCodeComment(props.threadId, comment);
  };
  const submitAgentNotePrompt = async (submission: WorkspaceAgentNoteSubmission) => {
    if (!inputProps.onSubmitAgentNote || agentNoteSubmissionBusy) {
      return false;
    }
    const trimmedPrompt = submission.prompt.trim();
    if (trimmedPrompt.length === 0) {
      return false;
    }
    setAgentNoteSubmissionBusy(true);
    try {
      const sent = await inputProps.onSubmitAgentNote({
        ...submission,
        prompt: trimmedPrompt,
        threadId: agentNoteThreadId,
      });
      setAgentNoteSubmissionBusy(false);
      return sent;
    } catch (error) {
      setAgentNoteSubmissionBusy(false);
      throw error;
    }
  };
  const handleQueueCodeSearchResult = (result: WorkspaceCodeSearchResult, lineNumber?: number) => {
    const line = lineNumber ?? result.snippets[0]?.lineNumber;
    queueWorkspaceFileContext(
      result.entry.path,
      line
        ? `Use ${result.entry.path}:${line} as context for the next agent step.`
        : `Use ${result.entry.path} as context for the next agent step.`,
    );
  };
  const handleSendCodeSearchResultToAgent = async (
    result: WorkspaceCodeSearchResult,
    lineNumber?: number,
  ) => {
    const line = lineNumber ?? result.snippets[0]?.lineNumber;
    const sent = await submitAgentNotePrompt({
      mode: "send",
      prompt: line
        ? `Inspect ${result.entry.path}:${line} and explain how it relates to the current task.`
        : `Inspect ${result.entry.path} and explain how it relates to the current task.`,
    });
    if (sent) {
      toastManager.add({
        title: "Sent to agent",
        description: result.entry.path,
        type: "success",
      });
    }
  };
  const handleAddAndSendCodeComment = async (comment: WorkspaceCodeComment) => {
    addCodeComment(props.threadId, comment);
    const sent = await submitAgentNotePrompt({
      mode: "send",
      prompt: buildWorkspaceCodeCommentPrompt(comment),
    });
    if (sent) {
      updateCodeCommentStatus(props.threadId, comment.id, "resolved");
      return true;
    }
    const queued = await submitAgentNotePrompt({
      mode: "queue",
      prompt: buildWorkspaceCodeCommentPrompt(comment),
    });
    if (queued) {
      updateCodeCommentStatus(props.threadId, comment.id, "queued");
    }
    return queued;
  };
  const handleSendQueuedContext = async (entry: QueuedWorkspaceContext) => {
    const sent = await submitAgentNotePrompt({ mode: "send", prompt: entry.prompt });
    if (!sent) {
      return;
    }
    setQueuedWorkspaceContexts((current) => current.filter((item) => item.id !== entry.id));
  };
  const handleUpdateQueuedContextPrompt = (entryId: string, prompt: string) => {
    setQueuedWorkspaceContexts((current) =>
      current.map((entry) => (entry.id === entryId ? { ...entry, prompt } : entry)),
    );
  };
  const handleSendCodeComment = async (comment: WorkspaceCodeComment) => {
    const sent = await submitAgentNotePrompt({
      mode: "send",
      prompt: buildWorkspaceCodeCommentPrompt(comment),
    });
    if (!sent) {
      return;
    }
    updateCodeCommentStatus(props.threadId, comment.id, "resolved");
  };
  const handleSendAllAgentNotes = async () => {
    if (queuedWorkspaceContexts.length === 0 && unresolvedCodeComments.length === 0) {
      return;
    }
    const combinedPrompt = buildCombinedAgentNotesPrompt(
      queuedWorkspaceContexts,
      unresolvedCodeComments,
    );
    const sent = await submitAgentNotePrompt({ mode: "send", prompt: combinedPrompt });
    if (!sent) {
      return;
    }
    setQueuedWorkspaceContexts([]);
    for (const comment of unresolvedCodeComments) {
      updateCodeCommentStatus(props.threadId, comment.id, "resolved");
    }
  };

  useEffect(() => {
    if (!activePane?.activeFilePath) {
      return;
    }
    expandDirectories(props.threadId, collectAncestorDirectories(activePane.activeFilePath));
  }, [activePane?.activeFilePath, expandDirectories, props.threadId]);

  const visibleRows = useMemo(() => {
    if (deferredTreeSearch.length > 0) {
      return searchEntries.map<TreeRow>((entry) => ({
        depth: 0,
        entry,
        hasChildren: false,
        kind: entry.kind,
        name: basenameOfPath(entry.path),
      }));
    }

    return buildTreeRows(treeEntries, new Set(expandedDirectoryPaths));
  }, [deferredTreeSearch, expandedDirectoryPaths, searchEntries, treeEntries]);

  const expandedDirectoryPathSet = new Set(expandedDirectoryPaths);
  const explorerRows = useMemo(
    () => buildExplorerRenderRows(visibleRows, inlineEntryState),
    [inlineEntryState, visibleRows],
  );
  const explorerPending =
    isWorkspaceTreePending || (searchMode && isWorkspaceTreeFetching && treeEntries.length === 0);

  const rowVirtualizer = useReactCompilerSafeVirtualizer({
    count: explorerRows.length,
    estimateSize: () => 32,
    getScrollElement: () => treeScrollRef.current,
    overscan: 12,
  });

  useEffect(() => {
    if (explorerPending || explorerRows.length === 0 || !props.gitCwd) {
      return;
    }

    const prefetchFilePaths: string[] = [];
    for (const row of explorerRows) {
      if (row.kind !== "entry" || row.row.kind !== "file") {
        continue;
      }
      if (!shouldPrefetchWorkspaceEditorFile(row.row.entry.path)) {
        continue;
      }
      prefetchFilePaths.push(row.row.entry.path);
      if (prefetchFilePaths.length >= WORKSPACE_EXPLORER_FILE_PREFETCH_LIMIT) {
        break;
      }
    }
    if (prefetchFilePaths.length === 0) {
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      for (const filePath of prefetchFilePaths) {
        void prefetchWorkspaceEditorFile(filePath);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [explorerPending, explorerRows, prefetchWorkspaceEditorFile, props.gitCwd]);

  const treeResizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const handleTreeResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    treeResizeStateRef.current = {
      pointerId: event.pointerId,
      startWidth: treeWidth,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    Object.assign(document.body.style, {
      cursor: "col-resize",
      userSelect: "none",
    });
  };
  const handleTreeResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = treeResizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    setTreeWidth(props.threadId, state.startWidth + (event.clientX - state.startX));
  };
  const handleTreeResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = treeResizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) {
      return;
    }
    treeResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };

  const paneResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    rowId: string;
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart =
    (rowId: string, dividerIndex: number, ratios: readonly number[]) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      paneResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        rowId,
        startRatios: [...ratios],
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      Object.assign(document.body.style, {
        cursor: "col-resize",
        userSelect: "none",
      });
    };
  const handlePaneResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = paneResizeStateRef.current;
    const container = rowGroupRefs.current.get(resizeState?.rowId ?? "") ?? null;
    if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
      return;
    }
    event.preventDefault();
    setPaneRatios(
      props.threadId,
      resizeState.rowId,
      resizePaneRatios({
        containerWidthPx: container.clientWidth,
        deltaPx: event.clientX - resizeState.startX,
        dividerIndex: resizeState.dividerIndex,
        minPaneWidthPx: 320,
        ratios: resizeState.startRatios,
      }),
    );
  };
  const handlePaneResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = paneResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    paneResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };

  const rowResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    startRatios: number[];
    startY: number;
  } | null>(null);
  const handleRowResizeStart =
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      rowResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        startRatios: normalizedRowRatios,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      Object.assign(document.body.style, {
        cursor: "row-resize",
        userSelect: "none",
      });
    };
  const handleRowResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = rowResizeStateRef.current;
    const container = editorGridRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
      return;
    }
    event.preventDefault();
    setRowRatios(
      props.threadId,
      resizePaneRatios({
        containerWidthPx: container.clientHeight,
        deltaPx: event.clientY - resizeState.startY,
        dividerIndex: resizeState.dividerIndex,
        minPaneWidthPx: 220,
        ratios: resizeState.startRatios,
      }),
    );
  };
  const handleRowResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = rowResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    rowResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };
  useEffect(() => {
    const resetResizeInteractions = () => {
      treeResizeStateRef.current = null;
      paneResizeStateRef.current = null;
      rowResizeStateRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetResizeInteractions();
      }
    };
    window.addEventListener("blur", resetResizeInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetResizeInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const workspaceFileCount = treeEntries.filter((entry) => entry.kind === "file").length;
  const activeWorktreePath = props.worktreePath ?? null;

  const handleSplitPane = useCallback(
    (paneId?: string, filePath?: string, direction: "down" | "right" = "right") => {
      const createdPaneId = splitPane(props.threadId, {
        direction,
        ...(filePath ? { filePath } : {}),
        ...(paneId ? { sourcePaneId: paneId } : {}),
      });
      if (createdPaneId) {
        return;
      }
      toastManager.add({
        description: `This milestone currently supports up to ${MAX_THREAD_EDITOR_PANES} editor windows.`,
        title: "Window limit reached",
        type: "info",
      });
    },
    [props.threadId, splitPane],
  );

  const handleOpenFile = (filePath: string, openInNewPane: boolean) => {
    setSelectedReviewFilePath(null);
    prepareWorkspaceFileOpen(filePath);
    if (openInNewPane) {
      handleSplitPane(activePane?.id, filePath);
      if (panes.length >= MAX_THREAD_EDITOR_PANES) {
        openFile(props.threadId, filePath, activePane?.id);
      }
      return;
    }
    openFile(props.threadId, filePath, activePane?.id);
  };
  const openCommandPalette = useCallback((mode: WorkspaceCommandPaletteMode) => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
  }, []);
  const requestFindInActiveEditor = useCallback(() => {
    bumpFindRequestToken();
  }, [bumpFindRequestToken]);
  const editorShortcutLabelOptions = {
    context: {
      browserOpen: props.browserOpen,
      editorFocus: true,
      terminalFocus: false,
      terminalOpen: props.terminalOpen,
    },
  };
  const openFilePaletteShortcutLabel = shortcutLabelForCommand(
    props.keybindings,
    "editor.openFilePalette",
    editorShortcutLabelOptions,
  );
  const findInActiveEditorShortcutLabel = shortcutLabelForCommand(
    props.keybindings,
    "editor.findInActiveEditor",
    editorShortcutLabelOptions,
  );
  const workspaceCommandActions: readonly WorkspaceCommandAction[] = [
    {
      id: "open-file",
      icon: "search",
      label: "Open File",
      ...(openFilePaletteShortcutLabel ? { shortcut: openFilePaletteShortcutLabel } : {}),
      run: () => openCommandPalette("files"),
    },
    {
      id: "search-text",
      description: "Search files and code like an agent would.",
      icon: "search",
      label: "Search Codebase",
      run: () => {
        setSidebarMode("search");
        setExplorerOpen(props.threadId, true);
      },
    },
    {
      id: "find-active-editor",
      description: "Open find in the active editor.",
      icon: "search",
      label: "Find in Active Editor",
      ...(findInActiveEditorShortcutLabel ? { shortcut: findInActiveEditorShortcutLabel } : {}),
      run: requestFindInActiveEditor,
    },
    {
      id: "source-control",
      description: `${changedFiles.length} changed files.`,
      icon: "git",
      label: "Open Review",
      run: () => {
        setSidebarMode("review");
        setExplorerOpen(props.threadId, true);
      },
    },
    {
      id: "review-active-file",
      disabled: !activePane?.activeFilePath,
      icon: "agent",
      label: "Review Active File",
      run: () => {
        if (!activePane?.activeFilePath || !props.gitCwd) {
          return;
        }
        queueWorkspaceSelectionContext(
          {
            cwd: props.gitCwd,
            diagnostics: [],
            kind: "workspace-selection",
            languageId: resolveWorkspaceLanguageFromFilePath(activePane.activeFilePath) ?? null,
            range: {
              relativePath: activePane.activeFilePath,
              startLine: 0,
              startColumn: 0,
              endLine: 0,
              endColumn: 0,
            },
            relativePath: activePane.activeFilePath,
            text: "",
          },
          `Review ${activePane.activeFilePath}.`,
        );
      },
    },
    {
      id: "split-right",
      icon: "code",
      label: "Split Editor Right",
      run: () => handleSplitPane(activePane?.id, undefined, "right"),
    },
    {
      id: "install-language-server",
      description: "Open settings for language tooling.",
      icon: "fix",
      label: "Install Language Server",
      run: () => {
        toastManager.add({
          description: "Language server management is available from settings.",
          title: "Language tooling",
          type: "info",
        });
      },
    },
  ];
  const handleOpenFileInPane = (paneId: string, filePath: string, targetIndex?: number) => {
    prepareWorkspaceFileOpen(filePath);
    openFile(props.threadId, filePath, paneId);
    if (typeof targetIndex === "number" && Number.isFinite(targetIndex)) {
      moveFile(props.threadId, {
        filePath,
        sourcePaneId: paneId,
        targetPaneId: paneId,
        targetIndex,
      });
    }
  };
  const handleSetActiveFile = useCallback(
    (paneId: string, filePath: string | null) => {
      if (filePath) {
        prepareWorkspaceFileOpen(filePath);
      }
      setActiveFile(props.threadId, filePath, paneId);
    },
    [prepareWorkspaceFileOpen, props.threadId, setActiveFile],
  );
  const handleRetryActiveFile = () => {
    if (!activePane?.activeFilePath) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.readFile(
        props.gitCwd,
        activePane.activeFilePath,
        inputProps.connectionUrl,
      ),
    });
  };

  const invalidateWorkspaceTree = () => {
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
    });
  };

  const clearReadFileCache = (relativePath: string) => {
    queryClient.removeQueries({
      predicate: (query) => {
        const queryKey = query.queryKey;
        const cachedRelativePath = queryKey[4];
        return (
          queryKey[0] === "projects" &&
          queryKey[1] === "read-file" &&
          queryKey[2] === (inputProps.connectionUrl ?? null) &&
          queryKey[3] === props.gitCwd &&
          typeof cachedRelativePath === "string" &&
          isAncestorPath(cachedRelativePath, relativePath)
        );
      },
    });
  };

  const focusMountedExplorerEntry = useCallback((path: string): boolean => {
    const target = treeScrollRef.current?.querySelector<HTMLElement>(
      `[data-explorer-path="${CSS.escape(path)}"]`,
    );
    if (!target) {
      return false;
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
    return true;
  }, []);

  const focusExplorerEntry = useCallback(
    (path: string, options?: { readonly align?: "auto" | "center" }) => {
      const rowIndex = explorerRows.findIndex(
        (row) => row.kind === "entry" && row.row.entry.path === path,
      );
      if (rowIndex >= 0) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: options?.align ?? "auto" });
      }
      window.requestAnimationFrame(() => {
        if (focusMountedExplorerEntry(path)) {
          return;
        }
        window.requestAnimationFrame(() => {
          focusMountedExplorerEntry(path);
        });
      });
    },
    [explorerRows, focusMountedExplorerEntry, rowVirtualizer],
  );

  useEffect(() => {
    const pendingExplorerRevealPath = pendingExplorerRevealPathRef.current;
    if (!pendingExplorerRevealPath || explorerPending) {
      return;
    }
    const visible = explorerRows.some(
      (row) => row.kind === "entry" && row.row.entry.path === pendingExplorerRevealPath,
    );
    if (!visible) {
      return;
    }
    setSelectedEntryPath(pendingExplorerRevealPath);
    focusExplorerEntry(pendingExplorerRevealPath, { align: "center" });
    pendingExplorerRevealPathRef.current = null;
  }, [explorerPending, explorerRows, focusExplorerEntry, setSelectedEntryPath]);

  const startInlineEntry = useCallback(
    (state: ExplorerInlineEntryState) => {
      if (state.parentPath) {
        expandDirectories(
          props.threadId,
          collectAncestorDirectories(state.parentPath).concat(state.parentPath),
        );
      }
      setInlineEntryState(state);
    },
    [expandDirectories, props.threadId],
  );

  const cancelInlineEntry = () => {
    setInlineEntryState(null);
  };
  const handleExplorerToggleDirectory = (directoryPath: string) => {
    toggleDirectory(props.threadId, directoryPath);
  };
  const handleExplorerRevealDirectoryFromSearch = (directoryPath: string) => {
    const directoriesToExpand = collectAncestorDirectories(directoryPath).concat(directoryPath);
    expandDirectories(props.threadId, directoriesToExpand);
    setSelectedEntryPath(directoryPath);
    setTreeSearch("");
    window.requestAnimationFrame(() => focusExplorerEntry(directoryPath));
  };
  const handleInlineExplorerValueChange = (value: string) => {
    setInlineEntryState((current) => (current ? { ...current, value } : current));
  };

  const visibleSelectedEntryPath =
    selectedEntryPath && entryByPath.has(selectedEntryPath)
      ? selectedEntryPath
      : (activePane?.activeFilePath ?? null);
  const focusedExplorerEntryPath = visibleSelectedEntryPath;
  const focusedExplorerEntry = focusedExplorerEntryPath
    ? (entryByPath.get(focusedExplorerEntryPath) ?? null)
    : null;

  const createEntryMutation = useMutation({
    mutationFn: async (input: { kind: "file" | "directory"; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.createEntry({
        ...withRpcRouteConnection(
          {
            cwd: props.gitCwd,
            kind: input.kind,
            relativePath: input.relativePath,
          },
          inputProps.connectionUrl,
        ),
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to create ${variables.relativePath}.`,
        title: variables.kind === "directory" ? "Could not create folder" : "Could not create file",
        type: "error",
      });
    },
    onSuccess: (result) => {
      const ancestorDirectories = collectAncestorDirectories(result.relativePath);
      expandDirectories(props.threadId, [
        ...ancestorDirectories,
        ...(result.kind === "directory" ? [result.relativePath] : []),
      ]);
      setSelectedEntryPath(result.relativePath);
      pendingExplorerRevealPathRef.current = result.relativePath;
      setTreeSearch("");
      if (result.kind === "file") {
        markFileSaved(props.threadId, result.relativePath, "");
        openFile(props.threadId, result.relativePath, activePane?.id);
      }
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
      });
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: result.kind === "directory" ? "Folder created" : "File created",
        type: "success",
      });
      setInlineEntryState(null);
    },
  });

  const renameEntryMutation = useMutation({
    mutationFn: async (input: {
      kind: "file" | "directory";
      nextRelativePath: string;
      relativePath: string;
    }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.renameEntry({
        ...withRpcRouteConnection(
          {
            cwd: props.gitCwd,
            nextRelativePath: input.nextRelativePath,
            relativePath: input.relativePath,
          },
          inputProps.connectionUrl,
        ),
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to rename ${variables.relativePath}.`,
        title: "Could not rename entry",
        type: "error",
      });
    },
    onSuccess: (result, variables) => {
      renameEntry(props.threadId, result.previousRelativePath, result.relativePath);
      expandDirectories(props.threadId, [
        ...collectAncestorDirectories(result.relativePath),
        ...(variables.kind === "directory" ? [result.relativePath] : []),
      ]);
      setSelectedEntryPath(result.relativePath);
      pendingExplorerRevealPathRef.current = result.relativePath;
      setTreeSearch("");
      clearReadFileCache(result.previousRelativePath);
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
      });
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: "Entry renamed",
        type: "success",
      });
      setInlineEntryState(null);
    },
  });

  const deleteEntryMutation = useMutation({
    mutationFn: async (input: { kind: "file" | "directory"; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.deleteEntry({
        ...withRpcRouteConnection(
          {
            cwd: props.gitCwd,
            relativePath: input.relativePath,
          },
          inputProps.connectionUrl,
        ),
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to delete ${variables.relativePath}.`,
        title: variables.kind === "directory" ? "Could not delete folder" : "Could not delete file",
        type: "error",
      });
    },
    onSuccess: (result) => {
      removeEntry(props.threadId, result.relativePath);
      clearReadFileCache(result.relativePath);
      setSelectedEntryPath(null);
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
      });
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: "Entry deleted",
        type: "success",
      });
    },
  });

  const handleDeleteEntry = async (entry: ProjectEntry) => {
    if (!api) {
      return;
    }
    const confirmed = await api.dialogs.confirm(
      [
        `Delete ${entry.kind === "directory" ? "folder" : "file"} "${basenameOfPath(entry.path)}"?`,
        entry.kind === "directory"
          ? "This permanently removes the folder and its contents."
          : "This permanently removes the file.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }
    void deleteEntryMutation.mutate({
      kind: entry.kind,
      relativePath: entry.path,
    });
  };

  const openExplorerContextMenu = async (
    entry: ProjectEntry | null,
    position: { x: number; y: number },
  ) => {
    if (!api) {
      return;
    }
    const items = [
      { id: "new-file", label: "New File" },
      { id: "new-folder", label: "New Folder" },
      { id: "reveal", label: entry ? revealEntryLabel : revealWorkspaceLabel },
      ...(entry
        ? [
            { id: "rename", label: "Rename" },
            { id: "delete", label: "Delete", destructive: true },
          ]
        : []),
    ] as const;
    const clicked = await api.contextMenu.show(items, position);
    const parentPath = entry?.kind === "directory" ? entry.path : (entry?.parentPath ?? null);

    if (clicked === "new-file") {
      startInlineEntry({ kind: "create-file", parentPath, value: "" });
      return;
    }
    if (clicked === "new-folder") {
      startInlineEntry({ kind: "create-folder", parentPath, value: "" });
      return;
    }
    if (clicked === "reveal") {
      if (!props.gitCwd) {
        toastManager.add({
          description: "This thread does not have an active workspace path.",
          title: "Workspace unavailable",
          type: "error",
        });
        return;
      }
      const targetPath = entry ? joinWorkspaceAbsolutePath(props.gitCwd, entry.path) : props.gitCwd;
      try {
        await api.shell.revealInFileManager(targetPath, {
          connectionUrl: inputProps.connectionUrl,
        });
      } catch (error) {
        toastManager.add({
          description: error instanceof Error ? error.message : "Unable to open the file manager.",
          title: "Could not reveal entry",
          type: "error",
        });
      }
      return;
    }
    if (clicked === "rename" && entry) {
      startInlineEntry({
        kind: "rename",
        entry,
        parentPath: entry.parentPath ?? null,
        value: basenameOfPath(entry.path),
      });
      return;
    }
    if (clicked === "delete" && entry) {
      await handleDeleteEntry(entry);
    }
  };

  const submitInlineEntry = () => {
    if (!inlineEntryState) {
      return;
    }

    const relativePath = pathForDialogInput(inlineEntryState.parentPath, inlineEntryState.value);
    if (
      relativePath.length === 0 ||
      inlineEntryState.value.trim() === "." ||
      inlineEntryState.value.trim() === ".."
    ) {
      toastManager.add({
        description: "Enter a valid workspace-relative name.",
        title: "Name required",
        type: "error",
      });
      return;
    }

    if (inlineEntryState.kind === "rename") {
      void renameEntryMutation.mutate({
        kind: inlineEntryState.entry.kind,
        nextRelativePath: relativePath,
        relativePath: inlineEntryState.entry.path,
      });
      return;
    }

    void createEntryMutation.mutate({
      kind: inlineEntryState.kind === "create-folder" ? "directory" : "file",
      relativePath,
    });
  };

  const moveExplorerEntry = (sourcePath: string, targetParentPath: string | null) => {
    const sourceEntry = entryByPath.get(sourcePath);
    if (!sourceEntry) {
      return;
    }
    if (
      targetParentPath !== null &&
      sourceEntry.kind === "directory" &&
      isAncestorPath(targetParentPath, sourcePath)
    ) {
      return;
    }
    const nextRelativePath = movePathToParent(sourcePath, targetParentPath);
    if (nextRelativePath === sourcePath) {
      return;
    }
    void renameEntryMutation.mutate({
      kind: sourceEntry.kind,
      nextRelativePath,
      relativePath: sourcePath,
    });
    setDragTargetParentPath(null);
  };
  const handleExplorerDropEntry = (sourcePath: string, targetParentPath: string | null) => {
    moveExplorerEntry(sourcePath, targetParentPath);
  };
  const handleExplorerRowContextMenu = (
    entry: ProjectEntry,
    position: { x: number; y: number },
  ) => {
    void openExplorerContextMenu(entry, position);
  };

  const selectedVisibleEntryIndex = visibleRows.findIndex(
    (row) => row.entry.path === focusedExplorerEntryPath,
  );

  const handleExplorerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (inlineEntryState || visibleRows.length === 0) {
      return;
    }
    const currentIndex = selectedVisibleEntryIndex >= 0 ? selectedVisibleEntryIndex : 0;
    const currentRow = visibleRows[currentIndex];
    if (!currentRow) {
      return;
    }

    const selectRowAtIndex = (index: number) => {
      const nextRow = visibleRows[Math.max(0, Math.min(index, visibleRows.length - 1))];
      if (!nextRow) {
        return;
      }
      setSelectedEntryPath(nextRow.entry.path);
      focusExplorerEntry(nextRow.entry.path);
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectRowAtIndex(currentIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectRowAtIndex(currentIndex - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      if (currentRow.kind === "directory") {
        event.preventDefault();
        if (!expandedDirectoryPathSet.has(currentRow.entry.path)) {
          toggleDirectory(props.threadId, currentRow.entry.path);
          return;
        }
        const nextRow = visibleRows[currentIndex + 1];
        if (nextRow && nextRow.depth > currentRow.depth) {
          setSelectedEntryPath(nextRow.entry.path);
          focusExplorerEntry(nextRow.entry.path);
        }
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (currentRow.kind === "directory" && expandedDirectoryPathSet.has(currentRow.entry.path)) {
        event.preventDefault();
        toggleDirectory(props.threadId, currentRow.entry.path);
        return;
      }
      const parentPath = currentRow.entry.parentPath ?? null;
      if (parentPath) {
        event.preventDefault();
        setSelectedEntryPath(parentPath);
        focusExplorerEntry(parentPath);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (currentRow.kind === "directory") {
        toggleDirectory(props.threadId, currentRow.entry.path);
        return;
      }
      handleOpenFile(currentRow.entry.path, false);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      startInlineEntry({
        kind: "rename",
        entry: currentRow.entry,
        parentPath: currentRow.entry.parentPath ?? null,
        value: basenameOfPath(currentRow.entry.path),
      });
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && focusedExplorerEntry) {
      event.preventDefault();
      void handleDeleteEntry(focusedExplorerEntry);
    }
  };

  const handleReopenClosedTab = useCallback(
    (paneId?: string) => {
      const reopenedPath = reopenClosedFile(props.threadId, paneId);
      if (reopenedPath) {
        toastManager.add({
          description: reopenedPath,
          title: "Tab reopened",
          type: "success",
        });
        return true;
      }
      toastManager.add({
        description: "There are no recently closed tabs for this workspace.",
        title: "Nothing to reopen",
        type: "info",
      });
      return false;
    },
    [props.threadId, reopenClosedFile],
  );

  const handleOpenFileToSide = (paneId: string, filePath: string) => {
    prepareWorkspaceFileOpen(filePath);
    handleSplitPane(paneId, filePath, "right");
  };

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !activePane) {
        return;
      }
      if (inlineEntryState || document.activeElement === treeSearchInputRef.current) {
        return;
      }
      if (shouldIgnoreEditorShortcutTarget(event.target)) {
        return;
      }
      const terminalFocus = isTerminalFocused();
      const command = resolveShortcutCommand(event, props.keybindings, {
        context: {
          browserOpen: props.browserOpen,
          editorFocus: !terminalFocus,
          terminalFocus,
          terminalOpen: props.terminalOpen,
        },
      });
      if (!command) {
        return;
      }

      if (command === "editor.openFilePalette") {
        event.preventDefault();
        event.stopPropagation();
        openCommandPalette("files");
        return;
      }

      if (command === "editor.openCommandPalette") {
        event.preventDefault();
        event.stopPropagation();
        openCommandPalette("commands");
        return;
      }

      if (command === "editor.findInActiveEditor") {
        event.preventDefault();
        event.stopPropagation();
        requestFindInActiveEditor();
        return;
      }

      if (command === "search.open") {
        event.preventDefault();
        event.stopPropagation();
        requestFindInActiveEditor();
        return;
      }

      if (command === "editor.split") {
        event.preventDefault();
        event.stopPropagation();
        handleSplitPane(activePane.id, undefined, "right");
        return;
      }

      if (command === "editor.splitDown") {
        event.preventDefault();
        event.stopPropagation();
        handleSplitPane(activePane.id, undefined, "down");
        return;
      }

      if (command === "editor.toggleWordWrap") {
        event.preventDefault();
        event.stopPropagation();
        updateSettings({ editorWordWrap: !editorSettings.wordWrap });
        toastManager.add({
          description: !editorSettings.wordWrap ? "Soft wrap enabled." : "Soft wrap disabled.",
          title: "Editor wrapping updated",
          type: "success",
        });
        return;
      }

      if (command === "editor.closeTab") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeFile(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.reopenClosedTab") {
        event.preventDefault();
        event.stopPropagation();
        handleReopenClosedTab(activePane.id);
        return;
      }

      if (command === "editor.closeOtherTabs") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOtherFiles(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.closeTabsToRight") {
        if (!activePane.activeFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeFilesToRight(props.threadId, activePane.activeFilePath, activePane.id);
        return;
      }

      if (command === "editor.newFile") {
        event.preventDefault();
        event.stopPropagation();
        startInlineEntry({
          kind: "create-file",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
          value: "",
        });
        return;
      }

      if (command === "editor.newFolder") {
        event.preventDefault();
        event.stopPropagation();
        startInlineEntry({
          kind: "create-folder",
          parentPath:
            focusedExplorerEntry?.kind === "directory"
              ? focusedExplorerEntry.path
              : (focusedExplorerEntry?.parentPath ?? null),
          value: "",
        });
        return;
      }

      if (command === "editor.rename") {
        if (!focusedExplorerEntry) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        startInlineEntry({
          kind: "rename",
          entry: focusedExplorerEntry,
          parentPath: focusedExplorerEntry.parentPath ?? null,
          value: basenameOfPath(focusedExplorerEntry.path),
        });
        return;
      }

      if (command === "editor.closeWindow") {
        if (panes.length <= 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        closePane(props.threadId, activePane.id);
        return;
      }

      if (command === "editor.focusNextWindow" || command === "editor.focusPreviousWindow") {
        if (panes.length <= 1) {
          return;
        }
        const currentIndex = orderedPaneIds.indexOf(activePane.id);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.focusNextWindow" ? 1 : -1;
        const nextPaneId =
          orderedPaneIds[(currentIndex + offset + orderedPaneIds.length) % orderedPaneIds.length];
        const nextPane = panesById.get(nextPaneId ?? "") ?? null;
        if (!nextPane) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setActivePane(props.threadId, nextPane.id);
        return;
      }

      if (command === "editor.nextTab" || command === "editor.previousTab") {
        if (activePane.openFilePaths.length <= 1 || !activePane.activeFilePath) {
          return;
        }
        const currentIndex = activePane.openFilePaths.indexOf(activePane.activeFilePath);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.nextTab" ? 1 : -1;
        const nextFilePath =
          activePane.openFilePaths[
            (currentIndex + offset + activePane.openFilePaths.length) %
              activePane.openFilePaths.length
          ];
        if (!nextFilePath) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        handleSetActiveFile(activePane.id, nextFilePath);
        return;
      }

      if (command === "editor.moveTabLeft" || command === "editor.moveTabRight") {
        if (!activePane.activeFilePath) {
          return;
        }
        const currentIndex = activePane.openFilePaths.indexOf(activePane.activeFilePath);
        if (currentIndex < 0) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        const direction = command === "editor.moveTabRight" ? 1 : -1;
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < activePane.openFilePaths.length) {
          moveFile(props.threadId, {
            filePath: activePane.activeFilePath,
            sourcePaneId: activePane.id,
            targetPaneId: activePane.id,
            targetIndex: nextIndex,
          });
          return;
        }

        const paneIndex = panes.findIndex((pane) => pane.id === activePane.id);
        const adjacentPane = panes[paneIndex + direction];
        if (!adjacentPane) {
          return;
        }
        moveFile(props.threadId, {
          filePath: activePane.activeFilePath,
          sourcePaneId: activePane.id,
          targetPaneId: adjacentPane.id,
          targetIndex: direction > 0 ? 0 : adjacentPane.openFilePaths.length,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activePane,
    closePane,
    closeFile,
    closeFilesToRight,
    closeOtherFiles,
    editorSettings.wordWrap,
    focusedExplorerEntry,
    handleSplitPane,
    handleSetActiveFile,
    handleReopenClosedTab,
    inlineEntryState,
    moveFile,
    openCommandPalette,
    orderedPaneIds,
    panes,
    panesById,
    props.browserOpen,
    props.keybindings,
    props.terminalOpen,
    props.threadId,
    requestFindInActiveEditor,
    setActivePane,
    startInlineEntry,
    updateSettings,
  ]);

  return (
    <div className="editor-render-island relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div
        className="grid min-h-0 min-w-0 flex-1 bg-transparent"
        style={{
          gridTemplateColumns: explorerOpen
            ? `minmax(240px, ${treeWidth}px) 4px minmax(0, 1fr)`
            : "minmax(0, 1fr)",
        }}
      >
        {explorerOpen ? (
          <>
            <aside className="flex min-h-0 min-w-0 flex-col border-r border-border/60 bg-[color-mix(in_srgb,var(--background)_97%,var(--muted)_3%)] text-foreground">
              <div
                className={cn(
                  "flex h-10 shrink-0 items-center gap-1 px-2",
                  APP_EDITOR_CHROME_HEADER_CLASS_NAME,
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <div className="flex shrink-0 items-center gap-1">
                    {(
                      [
                        ["explorer", "Files"],
                        ["search", "Search"],
                        ["review", "Review"],
                      ] as const
                    ).map(([mode, label]) => {
                      const active =
                        sidebarMode === mode ||
                        (mode === "review" &&
                          (sidebarMode === "source-control" ||
                            sidebarMode === "problems" ||
                            sidebarMode === "notes"));
                      const iconClassName = cn(
                        WORKSPACE_SIDEBAR_PRIMARY_MODE_ICON_CLASS,
                        active ? "text-foreground" : "text-muted-foreground/58",
                      );
                      const icon =
                        mode === "explorer" ? (
                          <IconFiles className={iconClassName} stroke={1.8} />
                        ) : mode === "search" ? (
                          <IconSearch className={iconClassName} stroke={1.9} />
                        ) : (
                          <IconGitCompare className={iconClassName} stroke={1.8} />
                        );

                      return (
                        <Tooltip key={mode}>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className={cn(
                                  WORKSPACE_SIDEBAR_PRIMARY_MODE_BUTTON_CLASS,
                                  active
                                    ? "text-foreground"
                                    : "text-muted-foreground/58 hover:text-foreground",
                                )}
                                onClick={() => setSidebarMode(mode)}
                                aria-label={label}
                                aria-pressed={active}
                              />
                            }
                          >
                            {icon}
                          </TooltipTrigger>
                          <TooltipPopup side="bottom">{label}</TooltipPopup>
                        </Tooltip>
                      );
                    })}
                  </div>
                  <div className="min-w-0 flex-1" />
                  {sidebarMode === "explorer" ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {activeWorktreePath ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                className={cn(
                                  "inline-flex items-center justify-center transition-colors",
                                  WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS,
                                )}
                              >
                                <GitForkIcon className={WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS} />
                              </span>
                            }
                          />
                          <TooltipPopup side="bottom" className="max-w-96 whitespace-pre-wrap">
                            {activeWorktreePath}
                          </TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {canDetachEditor ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className={WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS}
                                onClick={() => void detachEditor()}
                                aria-label="Detach editor"
                              >
                                <SquareArrowOutUpRightIcon
                                  className={WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS}
                                  strokeWidth={1.9}
                                />
                              </Button>
                            }
                          />
                          <TooltipPopup side="bottom">Detach editor</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {onReturnToMainWindow ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className={WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS}
                                onClick={onReturnToMainWindow}
                                aria-label="Move editor back to Ace"
                              >
                                <IconArrowsDiagonalMinimize2
                                  className={WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS}
                                  stroke={1.8}
                                />
                              </Button>
                            }
                          />
                          <TooltipPopup side="bottom">Move editor back to Ace</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className={WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS}
                              onClick={() =>
                                startInlineEntry({
                                  kind: "create-file",
                                  parentPath:
                                    focusedExplorerEntry?.kind === "directory"
                                      ? focusedExplorerEntry.path
                                      : (focusedExplorerEntry?.parentPath ?? null),
                                  value: "",
                                })
                              }
                              aria-label="New file"
                            />
                          }
                        >
                          <FilePlus2Icon className={WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS} />
                        </TooltipTrigger>
                        <TooltipPopup side="bottom">New file</TooltipPopup>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className={WORKSPACE_SIDEBAR_SECONDARY_BUTTON_CLASS}
                              onClick={() =>
                                startInlineEntry({
                                  kind: "create-folder",
                                  parentPath:
                                    focusedExplorerEntry?.kind === "directory"
                                      ? focusedExplorerEntry.path
                                      : (focusedExplorerEntry?.parentPath ?? null),
                                  value: "",
                                })
                              }
                              aria-label="New folder"
                            />
                          }
                        >
                          <FolderPlusIcon className={WORKSPACE_SIDEBAR_SECONDARY_ICON_CLASS} />
                        </TooltipTrigger>
                        <TooltipPopup side="bottom">New folder</TooltipPopup>
                      </Tooltip>
                    </div>
                  ) : null}
                </div>
              </div>
              {sidebarMode === "explorer" ? (
                <>
                  <div className="px-2 py-2">
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
                      <Input
                        ref={treeSearchInputRef}
                        nativeInput
                        value={treeSearch}
                        onChange={(event) => setTreeSearch(event.target.value)}
                        placeholder="Search files"
                        className={WORKSPACE_SIDEBAR_SEARCH_INPUT_CLASS}
                        type="search"
                      />
                    </div>
                  </div>
                  {searchMode || workspaceTreeData?.truncated ? (
                    <div className="flex h-6 items-center gap-1.5 border-b border-border/35 px-3 text-[10px] text-muted-foreground/70">
                      <span className="min-w-0 flex-1 truncate">
                        {searchMode ? "Matches" : "Indexed files"}
                      </span>
                      {workspaceTreeData?.truncated ? (
                        <span className="shrink-0 font-medium text-amber-600">partial</span>
                      ) : null}
                      <span className="shrink-0 tabular-nums">
                        {searchMode ? explorerRows.length : workspaceFileCount}
                      </span>
                    </div>
                  ) : null}
                  <div
                    ref={treeScrollRef}
                    role="tree"
                    aria-label="Workspace files"
                    className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-1.5"
                    tabIndex={0}
                    onKeyDown={handleExplorerKeyDown}
                    onDragOver={(event) => {
                      if (!readExplorerEntryTransferPath(event.dataTransfer)) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragTargetParentPath(null);
                    }}
                    onDrop={(event) => {
                      const path = readExplorerEntryTransferPath(event.dataTransfer);
                      if (!path) {
                        return;
                      }
                      event.preventDefault();
                      moveExplorerEntry(path, null);
                    }}
                    onContextMenu={(event) => {
                      if (event.target !== event.currentTarget) {
                        return;
                      }
                      event.preventDefault();
                      setSelectedEntryPath(null);
                      void openExplorerContextMenu(null, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    {explorerPending ? (
                      <div className="space-y-1 p-2">
                        {Array.from({ length: 10 }, (_, index) => {
                          const opacity = 1 - index * 0.06;
                          return (
                            <div
                              key={`explorer-pending-row-${opacity.toFixed(2)}`}
                              className="h-[22px] rounded-md bg-foreground/5"
                              style={{ opacity }}
                            />
                          );
                        })}
                      </div>
                    ) : explorerRows.length === 0 ? (
                      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                        {searchMode ? "No files match this search." : "No files found."}
                      </div>
                    ) : (
                      <div
                        className="relative"
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                      >
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                          const row = explorerRows[virtualRow.index];
                          if (!row) {
                            return null;
                          }
                          return (
                            <div
                              key={row.key}
                              className="absolute top-0 left-0 w-full"
                              style={{ transform: `translateY(${virtualRow.start}px)` }}
                            >
                              {row.kind === "entry" ? (
                                <FileTreeRow
                                  dragTargetPath={dragTargetParentPath}
                                  expandedDirectoryPaths={expandedDirectoryPathSet}
                                  focusedFilePath={activePane?.activeFilePath ?? null}
                                  gitStatus={gitStatusByPath.get(row.row.entry.path) ?? null}
                                  onDropEntry={handleExplorerDropEntry}
                                  onFocusEntry={setSelectedEntryPath}
                                  onHoverDropTarget={setDragTargetParentPath}
                                  onOpenFile={handleOpenFile}
                                  onPrefetchFile={prefetchWorkspaceEditorFile}
                                  onRevealDirectoryFromSearch={
                                    handleExplorerRevealDirectoryFromSearch
                                  }
                                  onOpenRowContextMenu={handleExplorerRowContextMenu}
                                  onSelectEntry={setSelectedEntryPath}
                                  onToggleDirectory={handleExplorerToggleDirectory}
                                  resolvedTheme={resolvedTheme}
                                  row={row.row}
                                  searchMode={searchMode}
                                  selectedEntryPath={visibleSelectedEntryPath}
                                />
                              ) : (
                                <InlineExplorerRow
                                  depth={row.depth}
                                  onCancel={cancelInlineEntry}
                                  onChangeValue={handleInlineExplorerValueChange}
                                  onCommit={submitInlineEntry}
                                  resolvedTheme={resolvedTheme}
                                  searchMode={searchMode}
                                  state={row.state}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : sidebarMode === "search" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="px-2 py-2">
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                      <Input
                        nativeInput
                        value={codeSearchQuery}
                        onChange={(event) => setCodeSearchQuery(event.target.value)}
                        placeholder="Search code"
                        className={WORKSPACE_SIDEBAR_SEARCH_INPUT_CLASS}
                        type="search"
                      />
                    </div>
                  </div>
                  {trimmedCodeSearchQuery.length >= 2 ? (
                    <div
                      className={cn(
                        "flex h-6 items-center gap-1.5 px-3 text-[10px] text-muted-foreground/70",
                        APP_EDITOR_CHROME_HEADER_CLASS_NAME,
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {codeSearchBusy ? "Searching" : "Matches"}
                      </span>
                      <span className="shrink-0 tabular-nums">{codeSearchResultCount}</span>
                    </div>
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
                    {trimmedCodeSearchQuery.length < 2 ? (
                      <div className="flex min-h-full flex-col px-2.5 pt-2 pb-3">
                        {visibleRecentCodeSearches.length > 0 ? (
                          <div className="space-y-1.5">
                            <div className="px-1 text-[11px] font-medium text-muted-foreground/68">
                              Recent searches
                            </div>
                            <div className="space-y-px">
                              {visibleRecentCodeSearches.map((query) => (
                                <button
                                  key={query}
                                  type="button"
                                  className="block w-full truncate rounded px-1 py-1 text-left text-[12px] leading-5 font-medium text-foreground/78 transition-colors hover:bg-accent/34 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/45 focus-visible:outline-none"
                                  onClick={() => handleCodeSearchExampleClick(query)}
                                >
                                  {query}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="min-h-6 flex-1" />
                        <div className="space-y-1.5">
                          <div className="px-1 text-[10px] font-medium text-muted-foreground/52">
                            Examples
                          </div>
                          <div className="space-y-0.5">
                            {WORKSPACE_CODE_SEARCH_EXAMPLE_QUERIES.map((query) => (
                              <button
                                key={query}
                                type="button"
                                className="block max-w-full truncate rounded px-1 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground/72 transition-colors hover:bg-accent/34 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/45 focus-visible:outline-none"
                                onClick={() => handleCodeSearchExampleClick(query)}
                              >
                                {query}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 py-0.5">
                        {codeSearchFileResults.length > 0 ? (
                          <section className="space-y-1.5">
                            <div className="px-3 pt-1 text-[10px] font-medium text-muted-foreground/62">
                              Files
                            </div>
                            {codeSearchFileResults.map((entry) => (
                              <button
                                key={entry.path}
                                type="button"
                                className="mx-1 flex w-[calc(100%-0.5rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/45 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:outline-none"
                                onClick={() => handleOpenCodeSearchFileResult(entry)}
                              >
                                <VscodeEntryIcon
                                  pathValue={entry.path}
                                  kind="file"
                                  theme={resolvedTheme}
                                  className="size-[15px] shrink-0"
                                />
                                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/88">
                                  {highlightWorkspaceCodeSearchText(
                                    entry.path,
                                    debouncedCodeSearchQuery,
                                  ).map((part, index) => (
                                    <span
                                      key={`${index}:${part.text}`}
                                      className={
                                        part.highlight
                                          ? "rounded-sm bg-primary/18 text-foreground"
                                          : undefined
                                      }
                                    >
                                      {part.text}
                                    </span>
                                  ))}
                                </span>
                              </button>
                            ))}
                          </section>
                        ) : null}
                        {codeSearchBusy ? (
                          <div className="space-y-2 p-1">
                            {Array.from({ length: 5 }, (_, index) => (
                              <div
                                key={`code-search-pending-${index}`}
                                className={cn(APP_WORKSPACE_INSET_CLASS_NAME, "space-y-1 p-2")}
                              >
                                <div className="h-3 w-3/4 rounded bg-foreground/6" />
                                <div className="h-3 w-full rounded bg-foreground/4" />
                                <div className="h-3 w-5/6 rounded bg-foreground/4" />
                              </div>
                            ))}
                          </div>
                        ) : isCodeSearchResultsError ? (
                          <div className="px-3 py-4 text-[11px] text-destructive">
                            Code search failed.
                          </div>
                        ) : codeSearchResultGroups.length === 0 &&
                          codeSearchFileResults.length === 0 ? (
                          <div className="px-3 py-4 text-[11px] text-muted-foreground/72">
                            No matches.
                          </div>
                        ) : null}
                        {!codeSearchBusy && !isCodeSearchResultsError
                          ? codeSearchResultGroups.map((group) => (
                              <section key={group.id} className="space-y-1.5">
                                <div className="px-3 pt-1 text-[10px] font-medium text-muted-foreground/62">
                                  {group.label}
                                </div>
                                {group.results.map((result) => (
                                  <div
                                    key={result.entry.path}
                                    className="group/result mx-1 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/45"
                                  >
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
                                        onClick={() => handleOpenCodeSearchResult(result)}
                                      >
                                        <VscodeEntryIcon
                                          pathValue={result.entry.path}
                                          kind="file"
                                          theme={resolvedTheme}
                                          className="size-[15px]"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/95">
                                          {result.entry.path}
                                        </span>
                                        <span className="rounded-sm bg-info/10 px-1.5 py-px text-[9px] font-medium text-info-foreground">
                                          {result.matchCount || "path"}
                                        </span>
                                      </button>
                                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/result:opacity-100 focus-within:opacity-100">
                                        <Tooltip>
                                          <TooltipTrigger
                                            render={
                                              <button
                                                type="button"
                                                className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground"
                                                onClick={() =>
                                                  handleSplitPane(activePane?.id, result.entry.path)
                                                }
                                                aria-label="Open to side"
                                              />
                                            }
                                          >
                                            <ExternalLinkIcon className="size-3" />
                                          </TooltipTrigger>
                                          <TooltipPopup side="bottom">Open to side</TooltipPopup>
                                        </Tooltip>
                                        <Tooltip>
                                          <TooltipTrigger
                                            render={
                                              <button
                                                type="button"
                                                className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground"
                                                onClick={() => {
                                                  void handleSendCodeSearchResultToAgent(result);
                                                }}
                                                aria-label="Send to agent"
                                              />
                                            }
                                          >
                                            <MessageSquareTextIcon className="size-3" />
                                          </TooltipTrigger>
                                          <TooltipPopup side="bottom">Send to agent</TooltipPopup>
                                        </Tooltip>
                                        <Tooltip>
                                          <TooltipTrigger
                                            render={
                                              <button
                                                type="button"
                                                className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground"
                                                onClick={() => handleQueueCodeSearchResult(result)}
                                                aria-label="Queue as context"
                                              />
                                            }
                                          >
                                            <ClipboardListIcon className="size-3" />
                                          </TooltipTrigger>
                                          <TooltipPopup side="bottom">
                                            Queue as context
                                          </TooltipPopup>
                                        </Tooltip>
                                      </div>
                                    </div>
                                    {result.snippets.length > 0 ? (
                                      <div className="mt-1 space-y-0.5 pl-5">
                                        {result.snippets.map((snippet) => (
                                          <button
                                            key={`${result.entry.path}:${snippet.lineNumber}:${snippet.text}`}
                                            type="button"
                                            className="flex w-full gap-2 rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground/82 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                                            onClick={() =>
                                              handleOpenCodeSearchResult(result, snippet.lineNumber)
                                            }
                                          >
                                            <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/65">
                                              {snippet.lineNumber}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate font-mono">
                                              {highlightWorkspaceCodeSearchText(
                                                snippet.text || " ",
                                                debouncedCodeSearchQuery,
                                              ).map((part, index) => (
                                                <span
                                                  key={`${index}:${part.text}`}
                                                  className={
                                                    part.highlight
                                                      ? "rounded-sm bg-primary/18 text-foreground"
                                                      : undefined
                                                  }
                                                >
                                                  {part.text}
                                                </span>
                                              ))}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="mt-1 truncate pl-5 text-[10px] text-muted-foreground/62">
                                        Path match
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </section>
                            ))
                          : null}
                      </div>
                    )}
                  </div>
                </div>
              ) : sidebarMode === "review" ||
                sidebarMode === "source-control" ||
                sidebarMode === "problems" ? (
                <div className="min-h-0 flex-1 overflow-y-auto py-1">
                  {changedFiles.length === 0 &&
                  workspaceProblems.length === 0 &&
                  queuedWorkspaceContexts.length === 0 &&
                  openCodeCommentCount === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-muted-foreground/62">
                      Clean working tree
                    </div>
                  ) : null}
                  {changedFiles.length > 0 ? (
                    <div className="border-b border-border/45 pb-1.5">
                      <div className="flex h-6 items-center gap-1.5 px-3 text-[10px] text-muted-foreground/65">
                        <GitBranchIcon className="size-3" />
                        <span className="min-w-0 flex-1 truncate">Changes</span>
                        <span className="tabular-nums">{changedFiles.length}</span>
                      </div>
                      {changedFiles.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className="group mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground/88 transition-colors hover:bg-accent/55 hover:text-foreground"
                          onClick={() => setSelectedReviewFilePath(file.path)}
                        >
                          <VscodeEntryIcon
                            pathValue={file.path}
                            kind="file"
                            theme={resolvedTheme}
                            className="size-[15px]"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">{file.path}</span>
                          {file.status ? (
                            <span
                              className={cn(
                                "text-[10px] font-semibold",
                                gitDecorationClass(file.status),
                              )}
                            >
                              {file.status}
                            </span>
                          ) : null}
                          <span className="rounded-sm bg-success/10 px-1 text-[10px] font-medium text-success">
                            +{file.insertions}
                          </span>
                          <span className="rounded-sm bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                            -{file.deletions}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {workspaceProblems.length > 0 ? (
                    <div className="border-b border-border/45 py-1.5">
                      <div className="flex h-6 items-center gap-1.5 px-3 text-[10px] text-muted-foreground/65">
                        <CircleAlertIcon className="size-3" />
                        <span className="min-w-0 flex-1 truncate">Problems</span>
                        <span className="tabular-nums">{workspaceProblems.length}</span>
                      </div>
                      {workspaceProblems.map((report) => (
                        <button
                          key={`${report.paneId}:${report.relativePath}:${report.problem.owner}:${report.problem.startLineNumber}:${report.problem.startColumn}:${report.problem.message}`}
                          type="button"
                          className="group mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent/55"
                          onClick={() => handleOpenProblem(report)}
                        >
                          <span
                            className={cn(
                              "mt-0.5 inline-flex min-w-[3.7rem] justify-center rounded px-1 py-px text-[9px] font-semibold uppercase",
                              problemSeverityClass(report.problem.severity),
                            )}
                          >
                            {problemSeverityLabel(report.problem.severity)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">
                              {report.problem.message}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/78">
                              {report.relativePath}:{report.problem.startLineNumber}:
                              {report.problem.startColumn}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {queuedWorkspaceContexts.length > 0 || openCodeCommentCount > 0 ? (
                    <div className="py-1.5">
                      <div className="flex h-6 items-center gap-1.5 px-3 text-[10px] text-muted-foreground/65">
                        <MessageSquareTextIcon className="size-3" />
                        <span className="min-w-0 flex-1 truncate">Review notes</span>
                        {inputProps.onSubmitAgentNote ? (
                          <button
                            type="button"
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-muted-foreground/76 transition-colors hover:bg-foreground/6 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => {
                              void handleSendAllAgentNotes();
                            }}
                            disabled={agentNoteSubmissionBusy}
                          >
                            {agentNoteSubmissionBusy ? "Sending..." : "Send all"}
                          </button>
                        ) : null}
                      </div>
                      <div className="space-y-1 px-1">
                        {queuedWorkspaceContexts.map((entry) => (
                          <div
                            key={entry.id}
                            className={cn(APP_WORKSPACE_INSET_CLASS_NAME, "px-2 py-1.5")}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <CircleDotIcon className="size-2.5 shrink-0 text-muted-foreground/52" />
                              <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-medium text-foreground/86">
                                {entry.context.relativePath}
                              </p>
                              <span className="shrink-0 rounded border border-border/45 px-1 py-px text-[8.5px] font-medium text-muted-foreground/58 uppercase">
                                {formatQueuedWorkspaceContextKind(entry)}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate pl-4 text-[10px] text-muted-foreground/62">
                              {formatQueuedWorkspaceContextDetail(entry)}
                            </p>
                            <textarea
                              className={cn(
                                APP_SETTINGS_FIELD_CLASS_NAME,
                                "mt-1.5 min-h-7 w-full resize-none rounded px-2 py-1 text-[10.5px] leading-4 text-foreground/82 outline-none placeholder:text-muted-foreground/42 focus:border-foreground/28 disabled:opacity-60",
                              )}
                              aria-label={`Review note for ${entry.context.relativePath}`}
                              value={entry.prompt}
                              onChange={(event) =>
                                handleUpdateQueuedContextPrompt(entry.id, event.currentTarget.value)
                              }
                              disabled={agentNoteSubmissionBusy}
                              rows={2}
                              placeholder="Tell the agent what to check"
                            />
                          </div>
                        ))}
                        {unresolvedCodeComments.map((comment) => (
                          <button
                            key={comment.id}
                            type="button"
                            className={cn(
                              APP_WORKSPACE_INSET_CLASS_NAME,
                              "block w-full p-2 text-left transition-colors hover:bg-foreground/[0.04]",
                            )}
                            onClick={() => handleOpenFile(comment.relativePath, false)}
                          >
                            <span className="block truncate text-[11px] font-semibold text-foreground">
                              {formatWorkspaceCodeCommentTitle(comment)}
                            </span>
                            <span className="mt-1 line-clamp-2 block text-[10px] text-muted-foreground">
                              {comment.body}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : sidebarMode === "notes" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-transparent px-3 text-[11px]">
                    <MessageSquareTextIcon className="size-3.5 text-muted-foreground/74" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                      Review Notes
                    </span>
                    {inputProps.onSubmitAgentNote &&
                    (queuedWorkspaceContexts.length > 0 || unresolvedCodeComments.length > 0) ? (
                      <button
                        type="button"
                        className={cn(
                          APP_WORKSPACE_INSET_CLASS_NAME,
                          "px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                        )}
                        onClick={() => {
                          void handleSendAllAgentNotes();
                        }}
                        disabled={agentNoteSubmissionBusy}
                      >
                        {agentNoteSubmissionBusy ? "Sending..." : "Send all"}
                      </button>
                    ) : null}
                    <span className="text-[10px] text-muted-foreground/76">
                      {openCodeCommentCount + queuedWorkspaceContexts.length}
                    </span>
                  </div>
                  {queuedWorkspaceContexts.length === 0 && openCodeCommentCount === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <MessageSquareTextIcon className="mx-auto mb-2 size-5 text-muted-foreground/45" />
                      Add a diff comment or queue a file/range for review.
                    </div>
                  ) : (
                    <div className="space-y-1.5 p-2">
                      {queuedWorkspaceContexts.map((entry) => (
                        <div
                          key={entry.id}
                          className={cn(
                            APP_WORKSPACE_INSET_CLASS_NAME,
                            "overflow-hidden rounded-lg",
                          )}
                        >
                          <div className="flex items-start gap-2 px-2 py-1.5">
                            <CircleDotIcon className="mt-1 size-3 text-muted-foreground/58" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-mono text-[10.5px] font-medium text-foreground/88">
                                {entry.context.relativePath}
                              </p>
                              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                <span className="shrink-0 rounded border border-border/45 px-1 py-px text-[8.5px] font-medium text-muted-foreground/58 uppercase">
                                  {formatQueuedWorkspaceContextKind(entry)}
                                </span>
                                <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/62">
                                  {formatQueuedWorkspaceContextDetail(entry)}
                                </p>
                              </div>
                              <textarea
                                className={cn(
                                  APP_SETTINGS_FIELD_CLASS_NAME,
                                  "mt-1.5 min-h-14 w-full resize-y rounded-md px-2 py-1.5 text-[11px] leading-4 text-foreground/84 outline-none placeholder:text-muted-foreground/42 focus:border-foreground/30 disabled:opacity-60",
                                )}
                                aria-label={`Review note for ${entry.context.relativePath}`}
                                value={entry.prompt}
                                onChange={(event) =>
                                  handleUpdateQueuedContextPrompt(
                                    entry.id,
                                    event.currentTarget.value,
                                  )
                                }
                                disabled={agentNoteSubmissionBusy}
                                rows={3}
                                placeholder="Tell the agent what to check"
                              />
                              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                {inputProps.onSubmitAgentNote ? (
                                  <button
                                    type="button"
                                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground/78 hover:bg-foreground/6 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                    onClick={() => {
                                      void handleSendQueuedContext(entry);
                                    }}
                                    disabled={agentNoteSubmissionBusy}
                                  >
                                    Send
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-foreground/6 hover:text-foreground"
                                  onClick={() =>
                                    setQueuedWorkspaceContexts((current) =>
                                      current.filter((item) => item.id !== entry.id),
                                    )
                                  }
                                  disabled={agentNoteSubmissionBusy}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      {unresolvedCodeComments.map((comment) => (
                        <div
                          key={comment.id}
                          className={cn(
                            APP_WORKSPACE_INSET_CLASS_NAME,
                            "overflow-hidden rounded-xl",
                          )}
                        >
                          <div className="flex items-start gap-2 border-l-2 border-primary/60 p-2">
                            <ClipboardListIcon className="mt-0.5 size-3.5 text-primary/80" />
                            <div className="min-w-0 flex-1">
                              <button
                                type="button"
                                className="block max-w-full truncate text-left text-[11px] font-semibold text-foreground hover:underline"
                                onClick={() => handleOpenFile(comment.relativePath, false)}
                              >
                                {formatWorkspaceCodeCommentTitle(comment)}
                              </button>
                              <pre className="mt-1 max-h-20 overflow-hidden rounded-sm border border-border/55 bg-foreground/4 p-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                {comment.code}
                              </pre>
                              <p className="mt-1 text-[11px] text-foreground/84">{comment.body}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-1">
                                {inputProps.onSubmitAgentNote ? (
                                  <button
                                    type="button"
                                    className="rounded-md bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/18 disabled:cursor-not-allowed disabled:opacity-60"
                                    onClick={() => {
                                      void handleSendCodeComment(comment);
                                    }}
                                    disabled={agentNoteSubmissionBusy}
                                  >
                                    Send
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="rounded-md bg-foreground/8 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 hover:bg-foreground/12"
                                  onClick={() =>
                                    updateCodeCommentStatus(props.threadId, comment.id, "queued")
                                  }
                                  disabled={agentNoteSubmissionBusy || comment.status === "queued"}
                                >
                                  {comment.status === "queued" ? "Queued" : "Queue"}
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md bg-foreground/8 px-1.5 py-0.5 text-[10px] hover:bg-foreground/12"
                                  onClick={() =>
                                    updateCodeCommentStatus(props.threadId, comment.id, "resolved")
                                  }
                                  disabled={agentNoteSubmissionBusy}
                                >
                                  Resolve
                                </button>
                                <button
                                  type="button"
                                  className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                  onClick={() => removeCodeComment(props.threadId, comment.id)}
                                  disabled={agentNoteSubmissionBusy}
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-transparent px-3 text-[11px]">
                    {sidebarMode === "outline" ? (
                      <ListTreeIcon className="size-3.5 text-muted-foreground/74" />
                    ) : (
                      <CircleAlertIcon className="size-3.5 text-muted-foreground/74" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                      {sidebarMode === "outline" ? "Outline" : "Problems"}
                    </span>
                    {sidebarMode === "outline" ? (
                      <span className="text-[10px] text-muted-foreground/76">
                        {workspaceSymbols.length}
                      </span>
                    ) : sidebarMode === "problems" ? (
                      <span className="text-[10px] text-muted-foreground/76">
                        {workspaceProblems.length}
                      </span>
                    ) : null}
                  </div>
                  {sidebarMode === "outline" && workspaceSymbols.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <div
                        className={cn(
                          APP_WORKSPACE_INSET_CLASS_NAME,
                          "mx-auto mb-2 flex size-7 items-center justify-center",
                        )}
                      >
                        <ListTreeIcon className="size-4 text-muted-foreground/55" />
                      </div>
                      No symbols detected in open editor files.
                    </div>
                  ) : sidebarMode === "outline" ? (
                    <div className="space-y-1.5 p-1.5">
                      {visibleOutlineGroups.map((group) => {
                        const fileCollapsed = collapsedOutlineIds.has(group.id);
                        const isActiveFile = activePane?.activeFilePath === group.relativePath;
                        return (
                          <div
                            key={group.id}
                            className={cn(
                              cn(APP_WORKSPACE_INSET_CLASS_NAME, "overflow-hidden rounded-[8px]"),
                              isActiveFile && "border-border bg-accent/40",
                            )}
                          >
                            <button
                              type="button"
                              className={cn(
                                "flex h-8 w-full items-center gap-2 border-b border-transparent px-2 text-left text-[11px] text-muted-foreground/88 transition-colors hover:bg-accent/55 hover:text-foreground",
                                !fileCollapsed && "border-border/65",
                              )}
                              onClick={() => toggleOutlineId(group.id)}
                            >
                              {fileCollapsed ? (
                                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/72" />
                              ) : (
                                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/72" />
                              )}
                              <VscodeEntryIcon
                                pathValue={group.relativePath}
                                kind="file"
                                theme={resolvedTheme}
                                className="size-3.5"
                              />
                              <span className="min-w-0 flex-1 truncate font-medium text-foreground/92">
                                {group.relativePath}
                              </span>
                              <span className="rounded-md bg-foreground/8 px-1.5 py-px text-[9px] tabular-nums text-muted-foreground/84">
                                {group.symbolCount}
                              </span>
                            </button>
                            {fileCollapsed ? null : (
                              <div className="py-1">
                                {group.symbols.map((node) => {
                                  const nodeCollapsed =
                                    node.hasChildren && collapsedOutlineIds.has(node.id);
                                  const isActiveSymbol = activeOutlineSymbolId === node.id;
                                  return (
                                    <button
                                      key={node.id}
                                      type="button"
                                      className={cn(
                                        "group mx-1 my-0.5 flex h-7 w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 text-left text-[11px] transition-colors",
                                        isActiveSymbol
                                          ? "bg-accent text-foreground"
                                          : "text-muted-foreground/90 hover:bg-accent/65 hover:text-foreground",
                                      )}
                                      onClick={() => {
                                        if (node.hasChildren) {
                                          toggleOutlineId(node.id);
                                          return;
                                        }
                                        handleOpenSymbol(node.report);
                                      }}
                                      onDoubleClick={() => handleOpenSymbol(node.report)}
                                    >
                                      <span
                                        className="flex min-w-0 flex-1 items-center gap-1.5"
                                        style={{
                                          paddingLeft: `${Math.min(54, node.depth * 12)}px`,
                                        }}
                                      >
                                        {node.hasChildren ? (
                                          nodeCollapsed ? (
                                            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70" />
                                          ) : (
                                            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/70" />
                                          )
                                        ) : (
                                          <span className="size-3 shrink-0" aria-hidden="true" />
                                        )}
                                        {symbolKindIcon(node.report.symbol.kind)}
                                        <span className="min-w-0 flex-1 truncate font-medium text-foreground/95">
                                          {node.report.symbol.name}
                                        </span>
                                      </span>
                                      <span
                                        className={cn(
                                          "shrink-0 rounded-md px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.01em]",
                                          symbolKindClass(node.report.symbol.kind),
                                        )}
                                      >
                                        {symbolKindLabel(node.report.symbol.kind)}
                                      </span>
                                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/75">
                                        {node.report.symbol.startLineNumber}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : workspaceProblems.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <CircleAlertIcon className="mx-auto mb-2 size-5 text-muted-foreground/45" />
                      No problems detected in open editor files.
                    </div>
                  ) : (
                    <div className="py-1.5">
                      {workspaceProblems.map((report) => (
                        <button
                          key={`${report.paneId}:${report.relativePath}:${report.problem.owner}:${report.problem.startLineNumber}:${report.problem.startColumn}:${report.problem.message}`}
                          type="button"
                          className="group mx-1 flex w-[calc(100%-0.5rem)] items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-accent"
                          onClick={() => handleOpenProblem(report)}
                        >
                          <span
                            className={cn(
                              "mt-0.5 inline-flex min-w-[3.7rem] justify-center rounded px-1 py-px text-[9px] font-semibold uppercase",
                              problemSeverityClass(report.problem.severity),
                            )}
                          >
                            {problemSeverityLabel(report.problem.severity)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">
                              {report.problem.message}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/78">
                              {report.relativePath}:{report.problem.startLineNumber}:
                              {report.problem.startColumn}
                              {report.problem.source ? ` · ${report.problem.source}` : ""}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </aside>

            <hr
              aria-label="Resize workspace sidebar"
              aria-orientation="vertical"
              className="group relative cursor-col-resize border-0 bg-background before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors before:content-[''] hover:bg-accent hover:before:bg-border"
              onPointerDown={handleTreeResizeStart}
              onPointerMove={handleTreeResizeMove}
              onPointerUp={handleTreeResizeEnd}
              onPointerCancel={handleTreeResizeEnd}
            />
          </>
        ) : null}

        <section className="min-h-0 min-w-0 overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-col">
            {selectedReviewFilePath ? (
              <WorkspaceReviewPane
                codeComments={codeComments}
                connectionUrl={inputProps.connectionUrl}
                cwd={props.gitCwd}
                filePath={selectedReviewFilePath}
                onAddCodeComment={handleAddCodeComment}
                onAskAgent={(filePath) =>
                  void submitAgentNotePrompt({
                    mode: "send",
                    prompt: `Review the working tree changes in ${filePath}. Call out risks, missing tests, and whether the change matches the current task.`,
                  })
                }
                onClose={() => setSelectedReviewFilePath(null)}
                onOpenFile={(filePath) => handleOpenFile(filePath, false)}
                onOpenToSide={(filePath) => {
                  setSelectedReviewFilePath(null);
                  handleSplitPane(activePane?.id, filePath, "right");
                }}
                onQueueContext={(filePath) =>
                  queueWorkspaceFileContext(
                    filePath,
                    `Review the working tree changes in ${filePath}.`,
                  )
                }
                resolvedTheme={resolvedTheme}
              />
            ) : (
              <div ref={editorGridRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {layoutRows.map((row, rowIndex) => (
                  <div key={row.id} className="contents">
                    <div
                      className="flex min-h-0 min-w-0"
                      style={{
                        flexBasis: 0,
                        flexGrow: normalizedRowRatios[rowIndex] ?? 1,
                        minHeight: 0,
                      }}
                    >
                      <div
                        ref={(node) => {
                          rowGroupRefs.current.set(row.id, node);
                        }}
                        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                      >
                        {row.panes.map((pane, paneIndex) => (
                          <div
                            key={pane.id}
                            className="flex min-h-0 min-w-0"
                            style={{
                              flexBasis: 0,
                              flexGrow: row.paneRatios[paneIndex] ?? 1,
                              minWidth: 0,
                            }}
                          >
                            <WorkspaceEditorPane
                              active={pane.id === activePaneId}
                              canClosePane={panes.length > 1}
                              canReopenClosedTab={hasRecentlyClosedFiles}
                              canSplitPane={panes.length < MAX_THREAD_EDITOR_PANES}
                              chromeActions={
                                rowIndex === 0 && paneIndex === row.panes.length - 1 ? (
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-xs"
                                            className={WORKSPACE_EDITOR_CHROME_PRIMARY_BUTTON_CLASS}
                                            onClick={() =>
                                              setExplorerOpen(props.threadId, !explorerOpen)
                                            }
                                            aria-label={
                                              explorerOpen
                                                ? "Collapse workspace explorer"
                                                : "Expand workspace explorer"
                                            }
                                          />
                                        }
                                      >
                                        {explorerOpen ? (
                                          <PanelLeftCloseIcon
                                            className={WORKSPACE_EDITOR_CHROME_PRIMARY_ICON_CLASS}
                                            strokeWidth={2}
                                          />
                                        ) : (
                                          <PanelLeftOpenIcon
                                            className={WORKSPACE_EDITOR_CHROME_PRIMARY_ICON_CLASS}
                                            strokeWidth={2}
                                          />
                                        )}
                                      </TooltipTrigger>
                                      <TooltipPopup side="bottom">
                                        {explorerOpen
                                          ? "Collapse workspace explorer"
                                          : "Expand workspace explorer"}
                                      </TooltipPopup>
                                    </Tooltip>
                                  </>
                                ) : undefined
                              }
                              connectionUrl={inputProps.connectionUrl}
                              codeComments={codeComments}
                              diagnosticsCwd={diagnosticsCwd}
                              dirtyFilePaths={activeDirtyPaths}
                              draftsByFilePath={draftsByFilePath}
                              editorOptions={editorOptions}
                              fileEventsConnected={fileEventsConnected}
                              gitCwd={props.gitCwd}
                              onAddCodeComment={handleAddCodeComment}
                              onAddCodeCommentAndSend={handleAddAndSendCodeComment}
                              onCloseFile={(paneId, filePath) =>
                                closeFile(props.threadId, filePath, paneId)
                              }
                              onCloseOtherTabs={(paneId, filePath) =>
                                closeOtherFiles(props.threadId, filePath, paneId)
                              }
                              onClosePane={(paneId) => closePane(props.threadId, paneId)}
                              onCloseTabsToRight={(paneId, filePath) =>
                                closeFilesToRight(props.threadId, filePath, paneId)
                              }
                              onDiscardDraft={(filePath) => discardDraft(props.threadId, filePath)}
                              onFocusPane={(paneId) => setActivePane(props.threadId, paneId)}
                              onHydrateFile={handleHydrateFile}
                              onMoveFile={(input) => moveFile(props.threadId, input)}
                              onOpenFileInPane={handleOpenFileInPane}
                              onOpenFileToSide={handleOpenFileToSide}
                              onProblemsChange={handlePaneProblemsChange}
                              onSymbolsChange={handlePaneSymbolsChange}
                              onQueueSelectionContext={queueWorkspaceSelectionContext}
                              onReopenClosedTab={handleReopenClosedTab}
                              onRetryActiveFile={handleRetryActiveFile}
                              onSaveFile={handleSaveFile}
                              onSetActiveFile={handleSetActiveFile}
                              onSplitPane={(paneId) => handleSplitPane(paneId, undefined, "right")}
                              onSplitPaneDown={(paneId) =>
                                handleSplitPane(paneId, undefined, "down")
                              }
                              onUpdateDraft={(filePath, contents) =>
                                updateDraft(props.threadId, filePath, contents)
                              }
                              pane={pane}
                              paneIndex={paneIndex}
                              problemNavigationTarget={problemNavigationTarget}
                              resolvedTheme={resolvedTheme}
                              savingFilePath={
                                saveMutation.isPending
                                  ? (saveMutation.variables?.relativePath ?? null)
                                  : null
                              }
                              symbolNavigationTarget={symbolNavigationTarget}
                              findRequestToken={pane.id === activePaneId ? findRequestToken : 0}
                            />
                            {paneIndex < row.panes.length - 1 ? (
                              <hr
                                aria-label={`Resize between editor windows ${paneIndex + 1} and ${paneIndex + 2}`}
                                aria-orientation="vertical"
                                className="group relative z-10 -mx-px w-2 shrink-0 cursor-col-resize touch-none select-none border-0 before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/55 before:transition-colors before:content-[''] group-hover:before:bg-foreground/30"
                                onPointerDown={handlePaneResizeStart(
                                  row.id,
                                  paneIndex,
                                  row.paneRatios,
                                )}
                                onPointerMove={handlePaneResizeMove}
                                onPointerUp={handlePaneResizeEnd}
                                onPointerCancel={handlePaneResizeEnd}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    {rowIndex < layoutRows.length - 1 ? (
                      <hr
                        aria-label={`Resize between editor rows ${rowIndex + 1} and ${rowIndex + 2}`}
                        aria-orientation="horizontal"
                        className="group relative z-10 -my-px h-2 shrink-0 cursor-row-resize touch-none select-none border-0 before:absolute before:top-1/2 before:left-0 before:h-px before:w-full before:-translate-y-1/2 before:bg-border/55 before:transition-colors before:content-[''] group-hover:before:bg-foreground/30"
                        onPointerDown={handleRowResizeStart(rowIndex)}
                        onPointerMove={handleRowResizeMove}
                        onPointerUp={handleRowResizeEnd}
                        onPointerCancel={handleRowResizeEnd}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <WorkspaceCommandPalette
        entries={treeEntries}
        mode={commandPaletteMode}
        onModeChange={setCommandPaletteMode}
        onOpenChange={setCommandPaletteOpen}
        onOpenFile={(path) => handleOpenFile(path, false)}
        open={commandPaletteOpen}
        resolvedTheme={resolvedTheme}
        workspaceActions={workspaceCommandActions}
      />
      <Dialog
        open={saveConflict !== null}
        onOpenChange={(open) => (!open ? setSaveConflict(null) : null)}
      >
        <DialogPopup className="max-w-[min(95vw,1100px)]">
          <DialogHeader>
            <DialogTitle>File changed on disk</DialogTitle>
            <DialogDescription>
              {saveConflict
                ? `${saveConflict.relativePath} was modified outside the editor. Review the diff, then overwrite the file or keep the disk version.`
                : "Review the conflict before saving."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {saveConflict ? (
              <div className="overflow-hidden rounded-md">
                <WorkspaceDiffEditor
                  activeFilePath={saveConflict.relativePath}
                  height={WORKSPACE_FILE_CONFLICT_DIFF_HEIGHT}
                  languageId={
                    resolveWorkspaceLanguageFromFilePath(saveConflict.relativePath) ?? null
                  }
                  original={saveConflict.currentContents}
                  modified={saveConflict.localContents}
                  options={diffEditorOptions}
                  resolvedTheme={resolvedTheme}
                />
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveConflict(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={handleUseDiskVersion}
              disabled={!saveConflict || saveMutation.isPending}
            >
              Keep Disk Version
            </Button>
            <Button
              onClick={handleOverwriteSaveConflict}
              disabled={!saveConflict || saveMutation.isPending}
            >
              Overwrite Disk File
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function ThreadWorkspaceEditor(
  inputProps: Parameters<typeof useThreadWorkspaceEditorComponent>[0],
) {
  return useThreadWorkspaceEditorComponent(inputProps);
}

export default ThreadWorkspaceEditor;
