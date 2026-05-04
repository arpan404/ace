import { DiffEditor } from "@monaco-editor/react";
import type {
  EditorId,
  GitWorkingTreeFileStatus,
  ProjectEntry,
  ProjectReadFileResult,
  ResolvedKeybindingsConfig,
  ThreadId,
  WorkspaceEditorLocation,
} from "@ace/contracts";
import { IconLayoutSidebar, IconLayoutSidebarFilled } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  FolderTreeIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  HashIcon,
  ListTreeIcon,
  MessageSquareTextIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
} from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  resolveEditorStateScopeId,
  type ThreadEditorRowState,
  MAX_THREAD_EDITOR_PANES,
  selectThreadEditorState,
  useEditorStateStore,
} from "~/editorStateStore";
import { usePreferredEditor } from "~/editorPreferences";
import { useAppearancePrefs } from "~/appearancePrefs";
import { useSetting, useUpdateSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { isTerminalFocused } from "~/lib/terminalFocus";
import {
  createWorkspaceDiffEditorOptions,
  createWorkspaceEditorOptions,
} from "~/lib/editor/workspaceEditorOptions";
import {
  mergeWorkspaceSearchEntries,
  searchWorkspaceEntriesLocally,
  shouldRunWorkspaceRemoteSearch,
} from "~/lib/editor/workspaceEntrySearch";
import { resolveMonacoLanguageFromFilePath } from "~/lib/editor/workspaceLanguageMapping";
import {
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
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { withRpcRouteConnection } from "~/lib/connectionRouting";
import { ensureMonacoConfigured } from "~/lib/editor/monacoSetup";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

import { OpenInEditorMenuSection, resolveOpenInEditorOptions } from "../chat/OpenInPicker";
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
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { readExplorerEntryTransferPath, writeExplorerEntryTransfer } from "./dragTransfer";
import { joinWorkspaceAbsolutePath, revealInFileManagerLabel } from "./workspaceFileUtils";
import WorkspaceEditorPane, {
  type WorkspaceEditorPaneProblem,
  type WorkspaceEditorPaneSymbol,
  type WorkspaceEditorProblemNavigationTarget,
  type WorkspaceEditorSymbolNavigationTarget,
} from "./WorkspaceEditorPane";
import {
  WorkspaceCommandPalette,
  type WorkspaceCommandAction,
  type WorkspaceCommandPaletteMode,
} from "./WorkspaceCommandPalette";

const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];
const WORKSPACE_TREE_REFETCH_INTERVAL_MS = 10_000;
const WORKSPACE_SEARCH_RESULT_LIMIT = 400;
const WORKSPACE_FILE_CONFLICT_DIFF_HEIGHT = 420;

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

const ExternalEditorOpenMenu = memo(function ExternalEditorOpenMenu({
  connectionUrl,
  gitCwd,
  keybindings,
  availableEditors,
}: {
  connectionUrl?: string | null | undefined;
  gitCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
}) {
  const api = readNativeApi();
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );
  const editorOptions = useMemo(
    () => resolveOpenInEditorOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const preferredEditorOption = useMemo(() => {
    const fallbackEditorOption = editorOptions[0];
    if (!preferredEditor) {
      return fallbackEditorOption;
    }
    return editorOptions.find((option) => option.value === preferredEditor) ?? fallbackEditorOption;
  }, [editorOptions, preferredEditor]);
  const handleOpenPreferredEditor = useCallback(() => {
    if (!api || !gitCwd || !preferredEditorOption) {
      return;
    }
    void api.shell.openInEditor(gitCwd, preferredEditorOption.value, { connectionUrl });
    setPreferredEditor(preferredEditorOption.value);
  }, [api, connectionUrl, gitCwd, preferredEditorOption, setPreferredEditor]);

  if (!gitCwd) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-0 max-w-[15rem] shrink-0 gap-1.5 rounded-[var(--control-radius)] border-border/60 bg-background/84 px-2.5 text-[11px] font-medium text-foreground/84 shadow-none hover:bg-background"
              aria-label={
                preferredEditorOption
                  ? `Open workspace in ${preferredEditorOption.label}`
                  : "Open workspace in external editor"
              }
              onClick={handleOpenPreferredEditor}
              disabled={!preferredEditorOption}
            >
              {preferredEditorOption ? (
                <preferredEditorOption.Icon className="size-3.5 shrink-0" />
              ) : null}
              <span className="truncate">
                {preferredEditorOption ? preferredEditorOption.label : "Open in editor"}
              </span>
            </Button>
          }
        />
        <TooltipPopup side="bottom" align="start" className="max-w-xs">
          {preferredEditorOption
            ? `Open this workspace in ${preferredEditorOption.label}.`
            : "Open this workspace in an installed editor."}
          {openFavoriteEditorShortcutLabel ? (
            <>
              {" "}
              <span className="text-muted-foreground">
                Favorite: {openFavoriteEditorShortcutLabel}
              </span>
            </>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-xs"
              className="size-7 shrink-0 rounded-[var(--control-radius)] border-border/60 bg-background/84 text-muted-foreground/78 shadow-none hover:bg-background hover:text-foreground"
              aria-label="Choose external editor"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-48">
          <OpenInEditorMenuSection
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={gitCwd}
          />
        </MenuPopup>
      </Menu>
    </div>
  );
});

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

function shouldIgnoreEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(".monaco-editor")) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

const FileTreeRow = memo(function FileTreeRow(props: {
  dragTargetPath: string | null;
  expandedDirectoryPaths: ReadonlySet<string>;
  focusedFilePath: string | null;
  gitStatus: GitWorkingTreeFileStatus | null;
  onDropEntry: (sourcePath: string, targetParentPath: string | null) => void;
  onFocusEntry: (path: string) => void;
  onHoverDropTarget: (targetParentPath: string | null) => void;
  onOpenFile: (filePath: string, openInNewPane: boolean) => void;
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

  return (
    <button
      type="button"
      className={cn(
        "group mx-1 flex h-[24px] w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-lg px-2 text-left text-[12px] transition-colors",
        isFocused
          ? "bg-accent text-foreground"
          : isSelected
            ? "bg-accent/70 text-foreground"
            : isDropTarget
              ? "bg-accent/80 text-foreground"
              : "text-muted-foreground/90 hover:bg-accent/60 hover:text-foreground",
      )}
      data-explorer-path={props.row.entry.path}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 10}px`,
      }}
      draggable
      onClick={(event) => {
        props.onSelectEntry(props.row.entry.path);
        if (props.row.kind === "directory") {
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path, event.altKey || event.metaKey);
      }}
      onFocus={() => {
        props.onFocusEntry(props.row.entry.path);
      }}
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
      title={
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
});

const InlineExplorerRow = memo(function InlineExplorerRow(props: {
  depth: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onChangeValue: (value: string) => void;
  onCommit: () => void;
  resolvedTheme: "light" | "dark";
  searchMode: boolean;
  state: ExplorerInlineEntryState;
}) {
  return (
    <div
      className="mx-1 flex h-[24px] w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-lg bg-accent px-2"
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.depth * 10}px`,
      }}
    >
      <span className="size-3.5 shrink-0" />
      <VscodeEntryIcon
        pathValue={
          props.state.kind === "rename"
            ? props.state.entry.path
            : props.state.kind === "create-folder"
              ? `${props.state.parentPath ?? "folder"}/folder`
              : `${props.state.parentPath ?? "file"}/file.ts`
        }
        kind={props.state.kind === "create-folder" ? "directory" : "file"}
        theme={props.resolvedTheme}
        className="size-[15px]"
      />
      <Input
        ref={props.inputRef}
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
        className="h-6 rounded-md border-border/60 bg-background/90 px-1.5 shadow-none"
        size="sm"
      />
    </div>
  );
});

function WorkspaceActivityButton(props: {
  active: boolean;
  badge?: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      className={cn(
        "relative my-0.5 flex size-8 items-center justify-center rounded-lg transition-colors",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
      )}
      onClick={props.onClick}
    >
      {props.icon}
      {props.badge && props.badge > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full border border-card bg-primary px-1 text-center text-[9px] font-semibold leading-4 text-primary-foreground shadow-sm">
          {props.badge > 9 ? "9+" : props.badge}
        </span>
      ) : null}
    </button>
  );
}

function ThreadWorkspaceEditor(inputProps: {
  availableEditors: ReadonlyArray<EditorId>;
  branch?: string | null;
  browserOpen: boolean;
  connectionUrl?: string | null | undefined;
  gitCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  lspCwd?: string | null;
  detachEnabled?: boolean;
  onDetached?: () => void;
  terminalOpen: boolean;
  threadId: ThreadId;
  worktreePath?: string | null;
  workspaceMode?: ThreadWorkspaceMode | undefined;
}) {
  const editorStateScopeId = useMemo(
    () => resolveEditorStateScopeId({ gitCwd: inputProps.gitCwd, threadId: inputProps.threadId }),
    [inputProps.gitCwd, inputProps.threadId],
  );
  const props = { ...inputProps, threadId: editorStateScopeId as ThreadId };
  const detachedEditorConnectionUrl = inputProps.connectionUrl;
  const detachedEditorThreadId = inputProps.threadId;
  const onEditorDetached = inputProps.onDetached;
  const canDetachEditor =
    inputProps.detachEnabled !== false && Boolean(window.desktopBridge?.openDetachedEditor);
  const detachEditor = useCallback(async () => {
    const openDetachedEditor = window.desktopBridge?.openDetachedEditor;
    if (!openDetachedEditor) {
      return;
    }
    const detached = await openDetachedEditor({
      threadId: detachedEditorThreadId,
      ...(detachedEditorConnectionUrl ? { connectionUrl: detachedEditorConnectionUrl } : {}),
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
  }, [detachedEditorConnectionUrl, detachedEditorThreadId, onEditorDetached]);

  const { resolvedTheme } = useTheme();
  const { themePreset } = useAppearancePrefs();
  const { updateSettings } = useUpdateSettings();
  const editorLineNumbers = useSetting("editorLineNumbers");
  const editorMinimap = useSetting("editorMinimap");
  const editorRenderWhitespace = useSetting("editorRenderWhitespace");
  const editorStickyScroll = useSetting("editorStickyScroll");
  const editorSuggestions = useSetting("editorSuggestions");
  const editorWordWrap = useSetting("editorWordWrap");
  const editorSettings = useMemo(
    () => ({
      lineNumbers: editorLineNumbers,
      minimap: editorMinimap,
      renderWhitespace: editorRenderWhitespace,
      stickyScroll: editorStickyScroll,
      suggestions: editorSuggestions,
      wordWrap: editorWordWrap,
    }),
    [
      editorLineNumbers,
      editorMinimap,
      editorRenderWhitespace,
      editorStickyScroll,
      editorSuggestions,
      editorWordWrap,
    ],
  );
  const queryClient = useQueryClient();
  const api = readNativeApi();
  const [treeSearch, setTreeSearch] = useState("");
  const [sidebarMode, setSidebarMode] = useState<WorkspaceSidebarMode>("explorer");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] =
    useState<WorkspaceCommandPaletteMode>("commands");
  const [queuedWorkspaceContexts, setQueuedWorkspaceContexts] = useState<
    readonly QueuedWorkspaceContext[]
  >([]);
  const deferredTreeSearch = useDeferredValue(treeSearch.trim());
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const treeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const entryDialogInputRef = useRef<HTMLInputElement | null>(null);
  const editorGridRef = useRef<HTMLDivElement | null>(null);
  const rowGroupRefs = useRef(new Map<string, HTMLDivElement | null>());
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
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [inlineEntryState, setInlineEntryState] = useState<ExplorerInlineEntryState | null>(null);
  const inlineEntryFocusKey =
    inlineEntryState?.kind === "rename"
      ? `rename:${inlineEntryState.entry.path}`
      : inlineEntryState
        ? `${inlineEntryState.kind}:${inlineEntryState.parentPath ?? "root"}`
        : null;
  const [dragTargetParentPath, setDragTargetParentPath] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflictState | null>(null);
  const [problemReportsByPaneId, setProblemReportsByPaneId] = useState<
    Record<
      string,
      { activeFilePath: string | null; problems: readonly WorkspaceEditorPaneProblem[] }
    >
  >({});
  const [symbolReportsByPaneId, setSymbolReportsByPaneId] = useState<
    Record<string, { activeFilePath: string | null; symbols: readonly WorkspaceEditorPaneSymbol[] }>
  >({});
  const [problemNavigationTarget, setProblemNavigationTarget] =
    useState<WorkspaceEditorProblemNavigationTarget | null>(null);
  const [symbolNavigationTarget, setSymbolNavigationTarget] =
    useState<WorkspaceEditorSymbolNavigationTarget | null>(null);
  const [collapsedOutlineIds, setCollapsedOutlineIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [activeOutlineSymbolId, setActiveOutlineSymbolId] = useState<string | null>(null);
  const hasRecentlyClosedFiles = useEditorStateStore(
    useCallback(
      (state) =>
        (state.runtimeStateByThreadId[props.threadId]?.recentlyClosedEntries.length ?? 0) > 0,
      [props.threadId],
    ),
  );
  const editorState = useEditorStateStore(
    useCallback(
      (state) =>
        selectThreadEditorState(
          state.threadStateByThreadId,
          state.runtimeStateByThreadId,
          props.threadId,
        ),
      [props.threadId],
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
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null,
    [activePaneId, panes],
  );
  const workspaceProblems = useMemo<readonly WorkspaceProblemReport[]>(
    () =>
      Object.entries(problemReportsByPaneId)
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
            problemSeverityRank(right.problem.severity) -
            problemSeverityRank(left.problem.severity);
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
        }),
    [problemReportsByPaneId],
  );
  const workspaceSymbols = useMemo<readonly WorkspaceSymbolReport[]>(
    () =>
      Object.entries(symbolReportsByPaneId)
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
        }),
    [symbolReportsByPaneId],
  );
  const outlineFileGroups = useMemo<readonly WorkspaceOutlineFileGroup[]>(() => {
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
  }, [workspaceSymbols]);
  const visibleOutlineGroups = useMemo<readonly WorkspaceOutlineFileGroup[]>(() => {
    return outlineFileGroups.map((group) => {
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
  }, [collapsedOutlineIds, outlineFileGroups]);
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
  const revealEntryLabel = useMemo(() => revealInFileManagerLabel(), []);
  const revealWorkspaceLabel = useMemo(() => {
    if (revealEntryLabel === "Reveal in Finder") {
      return "Reveal Workspace in Finder";
    }
    if (revealEntryLabel === "Reveal in Explorer") {
      return "Reveal Workspace in Explorer";
    }
    return "Reveal Workspace in File Manager";
  }, [revealEntryLabel]);
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane] as const)), [panes]);
  const diagnosticsCwd = props.gitCwd ?? props.lspCwd ?? null;
  const openWorkspaceFilePaths = useMemo(
    () => Array.from(new Set(panes.flatMap((pane) => pane.openFilePaths))).sort(),
    [panes],
  );
  const previousWorkspaceBufferStateRef = useRef<{
    cwd: string | null;
    filePaths: ReadonlySet<string>;
  }>({
    cwd: null,
    filePaths: new Set<string>(),
  });
  const editorOptions = useMemo(
    () => createWorkspaceEditorOptions(editorSettings),
    [editorSettings],
  );
  const diffEditorOptions = useMemo(() => createWorkspaceDiffEditorOptions(), []);
  const monacoTheme = ensureMonacoConfigured({
    resolvedTheme,
    themePreset,
  });

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

  const workspaceTreeQuery = useQuery({
    ...projectListTreeQueryOptions({
      connectionUrl: inputProps.connectionUrl,
      cwd: props.gitCwd,
      refetchInterval: WORKSPACE_TREE_REFETCH_INTERVAL_MS,
    }),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const gitStatusQuery = useQuery(gitStatusQueryOptions(props.gitCwd, inputProps.connectionUrl));
  const searchMode = deferredTreeSearch.length > 0;
  const remoteSearchEnabled = shouldRunWorkspaceRemoteSearch(deferredTreeSearch);
  const workspaceSearchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      connectionUrl: inputProps.connectionUrl,
      cwd: props.gitCwd,
      enabled: remoteSearchEnabled,
      limit: WORKSPACE_SEARCH_RESULT_LIMIT,
      query: deferredTreeSearch,
    }),
  );
  const treeEntries = workspaceTreeQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const localSearchEntries = useMemo(
    () =>
      searchMode
        ? searchWorkspaceEntriesLocally(treeEntries, deferredTreeSearch)
        : EMPTY_PROJECT_ENTRIES,
    [deferredTreeSearch, searchMode, treeEntries],
  );
  const remoteSearchEntries =
    remoteSearchEnabled && !workspaceSearchQuery.isPlaceholderData
      ? (workspaceSearchQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES)
      : EMPTY_PROJECT_ENTRIES;
  const searchEntries = useMemo(
    () =>
      mergeWorkspaceSearchEntries(
        localSearchEntries,
        remoteSearchEntries,
        WORKSPACE_SEARCH_RESULT_LIMIT,
      ),
    [localSearchEntries, remoteSearchEntries],
  );
  const entryByPath = useMemo(
    () => new Map(treeEntries.map((entry) => [entry.path, entry] as const)),
    [treeEntries],
  );

  useEffect(() => {
    if (treeEntries.length === 0) {
      return;
    }
    syncTree(
      props.threadId,
      treeEntries.map((entry) => entry.path),
    );
  }, [props.threadId, syncTree, treeEntries]);

  useEffect(() => {
    if (selectedEntryPath && entryByPath.has(selectedEntryPath)) {
      return;
    }
    setSelectedEntryPath(activePane?.activeFilePath ?? null);
  }, [activePane?.activeFilePath, entryByPath, selectedEntryPath]);

  useEffect(() => {
    if (!inlineEntryFocusKey) {
      return;
    }
    const timer = window.setTimeout(() => {
      entryDialogInputRef.current?.focus();
      entryDialogInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [inlineEntryFocusKey]);

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

  const handleSaveFile = useCallback(
    (relativePath: string, contents: string) => {
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
    },
    [inputProps.connectionUrl, props.gitCwd, queryClient, saveMutation],
  );
  const handleOverwriteSaveConflict = useCallback(() => {
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
  }, [saveConflict, saveMutation]);
  const handleUseDiskVersion = useCallback(() => {
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
  }, [
    inputProps.connectionUrl,
    markFileSaved,
    props.gitCwd,
    props.threadId,
    queryClient,
    saveConflict,
  ]);
  const handleHydrateFile = useCallback(
    (filePath: string, contents: string) => {
      hydrateFile(props.threadId, filePath, contents);
    },
    [hydrateFile, props.threadId],
  );

  const normalizedRowRatios = useMemo(
    () => normalizePaneRatios(paneRatios, rows.length),
    [paneRatios, rows.length],
  );
  const layoutRows = useMemo(
    () =>
      rows
        .map((row) => {
          const rowPanes = row.paneIds
            .map((paneId) => panesById.get(paneId) ?? null)
            .filter((pane): pane is NonNullable<typeof pane> => pane !== null);
          if (rowPanes.length === 0) {
            return null;
          }
          return {
            ...row,
            paneRatios: normalizePaneRatios(row.paneRatios, rowPanes.length),
            panes: rowPanes,
          };
        })
        .filter((row): row is ThreadEditorRowState & { panes: typeof panes } => row !== null),
    [panesById, rows],
  );
  const orderedPaneIds = useMemo(() => layoutRows.flatMap((row) => row.paneIds), [layoutRows]);

  const activeDirtyPaths = useMemo(
    () =>
      new Set(
        Object.entries(draftsByFilePath)
          .filter(([, draft]) => draft.draftContents !== draft.savedContents)
          .map(([path]) => path),
      ),
    [draftsByFilePath],
  );
  const gitStatusByPath = useMemo(() => {
    const files = gitStatusQuery.data?.workingTree.files ?? [];
    return new Map(
      files
        .filter((file): file is typeof file & { status: GitWorkingTreeFileStatus } =>
          Boolean(file.status),
        )
        .map((file) => [file.path, file.status] as const),
    );
  }, [gitStatusQuery.data?.workingTree.files]);
  const changedFiles = gitStatusQuery.data?.workingTree.files ?? [];
  const openCodeCommentCount = useMemo(
    () => countOpenWorkspaceCodeComments(codeComments),
    [codeComments],
  );
  const queueWorkspaceSelectionContext = useCallback(
    (context: WorkspaceSelectionContext, prompt: string) => {
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
      setSidebarMode("notes");
      setExplorerOpen(props.threadId, true);
      toastManager.add({
        description: `${context.relativePath}:${context.range.startLine + 1}-${context.range.endLine + 1}`,
        title: "Editor context queued",
        type: "success",
      });
    },
    [props.threadId, setExplorerOpen],
  );
  const handlePaneProblemsChange = useCallback(
    (
      paneId: string,
      activeFilePath: string | null,
      problems: readonly WorkspaceEditorPaneProblem[],
    ) => {
      setProblemReportsByPaneId((current) => {
        const previous = current[paneId];
        if (
          previous?.activeFilePath === activeFilePath &&
          previous.problems.length === problems.length &&
          previous.problems.every((problem, index) => {
            const next = problems[index];
            return (
              next &&
              problem.message === next.message &&
              problem.severity === next.severity &&
              problem.startLineNumber === next.startLineNumber &&
              problem.startColumn === next.startColumn &&
              problem.endLineNumber === next.endLineNumber &&
              problem.endColumn === next.endColumn
            );
          })
        ) {
          return current;
        }
        return {
          ...current,
          [paneId]: { activeFilePath, problems },
        };
      });
    },
    [],
  );
  const handlePaneSymbolsChange = useCallback(
    (
      paneId: string,
      activeFilePath: string | null,
      symbols: readonly WorkspaceEditorPaneSymbol[],
    ) => {
      setSymbolReportsByPaneId((current) => {
        const previous = current[paneId];
        if (
          previous?.activeFilePath === activeFilePath &&
          previous.symbols.length === symbols.length &&
          previous.symbols.every((symbol, index) => {
            const next = symbols[index];
            return (
              next &&
              symbol.name === next.name &&
              symbol.kind === next.kind &&
              symbol.startLineNumber === next.startLineNumber &&
              symbol.startColumn === next.startColumn &&
              symbol.endLineNumber === next.endLineNumber &&
              symbol.endColumn === next.endColumn &&
              symbol.depth === next.depth
            );
          })
        ) {
          return current;
        }
        return {
          ...current,
          [paneId]: { activeFilePath, symbols },
        };
      });
    },
    [],
  );
  const handleOpenProblem = useCallback(
    (report: WorkspaceProblemReport) => {
      const targetPaneId = panesById.has(report.paneId) ? report.paneId : (activePane?.id ?? null);
      if (!targetPaneId) {
        return;
      }
      setActivePane(props.threadId, targetPaneId);
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
    [activePane?.id, openFile, panesById, props.threadId, setActivePane],
  );
  const handleOpenSymbol = useCallback(
    (report: WorkspaceSymbolReport) => {
      setActiveOutlineSymbolId(workspaceSymbolNodeId(report));
      const targetPaneId = panesById.has(report.paneId) ? report.paneId : (activePane?.id ?? null);
      if (!targetPaneId) {
        return;
      }
      setActivePane(props.threadId, targetPaneId);
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
    [activePane?.id, openFile, panesById, props.threadId, setActivePane],
  );
  const toggleOutlineId = useCallback((id: string) => {
    setCollapsedOutlineIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const handleAddCodeComment = useCallback(
    (comment: WorkspaceCodeComment) => {
      addCodeComment(props.threadId, comment);
      setSidebarMode("notes");
      setExplorerOpen(props.threadId, true);
      toastManager.add({
        description: formatWorkspaceCodeCommentTitle(comment),
        title: "Code comment added",
        type: "success",
      });
    },
    [addCodeComment, props.threadId, setExplorerOpen],
  );

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

  const expandedDirectoryPathSet = useMemo(
    () => new Set(expandedDirectoryPaths),
    [expandedDirectoryPaths],
  );
  const explorerRows = useMemo(
    () => buildExplorerRenderRows(visibleRows, inlineEntryState),
    [inlineEntryState, visibleRows],
  );
  const explorerPending =
    workspaceTreeQuery.isPending ||
    (searchMode &&
      remoteSearchEnabled &&
      workspaceSearchQuery.isPending &&
      localSearchEntries.length === 0);

  const rowVirtualizer = useVirtualizer({
    count: explorerRows.length,
    estimateSize: () => 32,
    getScrollElement: () => treeScrollRef.current,
    overscan: 12,
  });

  const treeResizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const handleTreeResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      treeResizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: treeWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [treeWidth],
  );
  const handleTreeResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = treeResizeStateRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }
      setTreeWidth(props.threadId, state.startWidth + (event.clientX - state.startX));
    },
    [props.threadId, setTreeWidth],
  );
  const handleTreeResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
  }, []);

  const paneResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    rowId: string;
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart = useCallback(
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
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      },
    [],
  );
  const handlePaneResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [props.threadId, setPaneRatios],
  );
  const handlePaneResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
  }, []);

  const rowResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    startRatios: number[];
    startY: number;
  } | null>(null);
  const handleRowResizeStart = useCallback(
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      rowResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        startRatios: normalizedRowRatios,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [normalizedRowRatios],
  );
  const handleRowResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [props.threadId, setRowRatios],
  );
  const handleRowResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
  }, []);
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

  const workspaceFileCount = useMemo(
    () => treeEntries.filter((entry) => entry.kind === "file").length,
    [treeEntries],
  );
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

  const handleOpenFile = useCallback(
    (filePath: string, openInNewPane: boolean) => {
      if (openInNewPane) {
        handleSplitPane(activePane?.id, filePath);
        if (panes.length >= MAX_THREAD_EDITOR_PANES) {
          openFile(props.threadId, filePath, activePane?.id);
        }
        return;
      }
      openFile(props.threadId, filePath, activePane?.id);
    },
    [activePane?.id, handleSplitPane, openFile, panes.length, props.threadId],
  );
  const openCommandPalette = useCallback((mode: WorkspaceCommandPaletteMode) => {
    setCommandPaletteMode(mode);
    setCommandPaletteOpen(true);
  }, []);
  const workspaceCommandActions = useMemo<readonly WorkspaceCommandAction[]>(
    () => [
      {
        id: "open-file",
        icon: "search",
        label: "Open File",
        shortcut: "⌘P",
        run: () => openCommandPalette("files"),
      },
      {
        id: "search-text",
        description: "Switch to workspace search.",
        icon: "search",
        label: "Search Text",
        shortcut: "⌘⇧F",
        run: () => {
          setSidebarMode("search");
          setExplorerOpen(props.threadId, true);
          treeSearchInputRef.current?.focus();
        },
      },
      {
        id: "source-control",
        description: `${changedFiles.length} changed files.`,
        icon: "git",
        label: "Open Source Control",
        run: () => {
          setSidebarMode("source-control");
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
              languageId: resolveMonacoLanguageFromFilePath(activePane.activeFilePath) ?? null,
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
        id: "agent-notes",
        description: `${openCodeCommentCount} open code comments, ${queuedWorkspaceContexts.length} queued contexts.`,
        icon: "comment",
        label: "Open Agent Notes",
        run: () => {
          setSidebarMode("notes");
          setExplorerOpen(props.threadId, true);
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
    ],
    [
      activePane?.activeFilePath,
      activePane?.id,
      changedFiles.length,
      handleSplitPane,
      openCodeCommentCount,
      openCommandPalette,
      props.gitCwd,
      props.threadId,
      queuedWorkspaceContexts.length,
      queueWorkspaceSelectionContext,
      setExplorerOpen,
    ],
  );
  const handleOpenFileInPane = useCallback(
    (paneId: string, filePath: string, targetIndex?: number) => {
      openFile(props.threadId, filePath, paneId);
      if (typeof targetIndex === "number" && Number.isFinite(targetIndex)) {
        moveFile(props.threadId, {
          filePath,
          sourcePaneId: paneId,
          targetPaneId: paneId,
          targetIndex,
        });
      }
    },
    [moveFile, openFile, props.threadId],
  );
  const handleRetryActiveFile = useCallback(() => {
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
  }, [activePane?.activeFilePath, inputProps.connectionUrl, props.gitCwd, queryClient]);

  const invalidateWorkspaceTree = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listTree(props.gitCwd, inputProps.connectionUrl),
    });
  }, [inputProps.connectionUrl, props.gitCwd, queryClient]);

  const clearReadFileCache = useCallback(
    (relativePath: string) => {
      queryClient.removeQueries({
        queryKey: projectQueryKeys.readFile(props.gitCwd, relativePath, inputProps.connectionUrl),
        exact: true,
      });
    },
    [inputProps.connectionUrl, props.gitCwd, queryClient],
  );

  const focusExplorerEntry = useCallback((path: string) => {
    const target = treeScrollRef.current?.querySelector<HTMLElement>(
      `[data-explorer-path="${CSS.escape(path)}"]`,
    );
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, []);

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

  const cancelInlineEntry = useCallback(() => {
    setInlineEntryState(null);
  }, []);

  const focusedExplorerEntryPath = selectedEntryPath ?? activePane?.activeFilePath ?? null;
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
      if (result.kind === "file") {
        markFileSaved(props.threadId, result.relativePath, "");
        openFile(props.threadId, result.relativePath, activePane?.id);
      }
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
      clearReadFileCache(result.previousRelativePath);
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
      invalidateWorkspaceTree();
      toastManager.add({
        description: result.relativePath,
        title: "Entry deleted",
        type: "success",
      });
    },
  });

  const handleDeleteEntry = useCallback(
    async (entry: ProjectEntry) => {
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
    },
    [api, deleteEntryMutation],
  );

  const openExplorerContextMenu = useCallback(
    async (entry: ProjectEntry | null, position: { x: number; y: number }) => {
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
        const targetPath = entry
          ? joinWorkspaceAbsolutePath(props.gitCwd, entry.path)
          : props.gitCwd;
        try {
          await api.shell.revealInFileManager(targetPath, {
            connectionUrl: inputProps.connectionUrl,
          });
        } catch (error) {
          toastManager.add({
            description:
              error instanceof Error ? error.message : "Unable to open the file manager.",
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
    },
    [
      api,
      handleDeleteEntry,
      inputProps.connectionUrl,
      props.gitCwd,
      revealEntryLabel,
      revealWorkspaceLabel,
      startInlineEntry,
    ],
  );

  const submitInlineEntry = useCallback(() => {
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
  }, [createEntryMutation, inlineEntryState, renameEntryMutation]);

  const moveExplorerEntry = useCallback(
    (sourcePath: string, targetParentPath: string | null) => {
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
    },
    [entryByPath, renameEntryMutation],
  );

  const selectedVisibleEntryIndex = useMemo(
    () => visibleRows.findIndex((row) => row.entry.path === focusedExplorerEntryPath),
    [focusedExplorerEntryPath, visibleRows],
  );

  const handleExplorerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
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
        if (
          currentRow.kind === "directory" &&
          expandedDirectoryPathSet.has(currentRow.entry.path)
        ) {
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
    },
    [
      expandedDirectoryPathSet,
      focusExplorerEntry,
      focusedExplorerEntry,
      handleDeleteEntry,
      handleOpenFile,
      inlineEntryState,
      props.threadId,
      selectedVisibleEntryIndex,
      startInlineEntry,
      toggleDirectory,
      visibleRows,
    ],
  );

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

  const handleOpenFileToSide = useCallback(
    (paneId: string, filePath: string) => {
      handleSplitPane(paneId, filePath, "right");
    },
    [handleSplitPane],
  );

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
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopPropagation();
        openCommandPalette("files");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopPropagation();
        openCommandPalette("commands");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setSidebarMode("search");
        setExplorerOpen(props.threadId, true);
        window.setTimeout(() => treeSearchInputRef.current?.focus(), 0);
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

      if (command === "search.open") {
        event.preventDefault();
        event.stopPropagation();
        setSidebarMode("search");
        setExplorerOpen(props.threadId, true);
        window.setTimeout(() => treeSearchInputRef.current?.focus(), 0);
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
        setActiveFile(props.threadId, nextFilePath, activePane.id);
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
    setActiveFile,
    setActivePane,
    setExplorerOpen,
    startInlineEntry,
    updateSettings,
  ]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div
        className="grid min-h-0 min-w-0 flex-1 bg-background"
        style={{
          gridTemplateColumns: explorerOpen
            ? `52px minmax(220px, ${treeWidth}px) 4px minmax(0, 1fr)`
            : "52px minmax(0, 1fr)",
        }}
      >
        <nav className="flex min-h-0 flex-col items-center border-r border-border bg-card/80 py-2">
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "explorer"}
            icon={<FolderTreeIcon className="size-4" />}
            label="Explorer"
            onClick={() => {
              setSidebarMode("explorer");
              setExplorerOpen(props.threadId, true);
            }}
          />
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "search"}
            icon={<SearchIcon className="size-4" />}
            label="Search"
            onClick={() => {
              setSidebarMode("search");
              setExplorerOpen(props.threadId, true);
              window.setTimeout(() => treeSearchInputRef.current?.focus(), 0);
            }}
          />
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "source-control"}
            badge={changedFiles.length}
            icon={<GitBranchIcon className="size-4" />}
            label="Source Control"
            onClick={() => {
              setSidebarMode("source-control");
              setExplorerOpen(props.threadId, true);
            }}
          />
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "outline"}
            icon={<ListTreeIcon className="size-4" />}
            label="Outline"
            onClick={() => {
              setSidebarMode("outline");
              setExplorerOpen(props.threadId, true);
            }}
          />
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "problems"}
            badge={workspaceProblems.length}
            icon={<CircleAlertIcon className="size-4" />}
            label="Problems"
            onClick={() => {
              setSidebarMode("problems");
              setExplorerOpen(props.threadId, true);
            }}
          />
          <WorkspaceActivityButton
            active={explorerOpen && sidebarMode === "notes"}
            badge={openCodeCommentCount + queuedWorkspaceContexts.length}
            icon={<MessageSquareTextIcon className="size-4" />}
            label="Agent Notes"
            onClick={() => {
              setSidebarMode("notes");
              setExplorerOpen(props.threadId, true);
            }}
          />
          <div className="mt-auto">
            <WorkspaceActivityButton
              active={false}
              icon={
                explorerOpen ? (
                  <PanelLeftCloseIcon className="size-4.5" />
                ) : (
                  <PanelLeftOpenIcon className="size-4.5" />
                )
              }
              label={explorerOpen ? "Collapse sidebar" : "Open sidebar"}
              onClick={() => setExplorerOpen(props.threadId, !explorerOpen)}
            />
          </div>
        </nav>
        {explorerOpen ? (
          <>
            <aside className="flex min-h-0 min-w-0 flex-col border-r border-border bg-card/68 text-foreground">
              <div className="flex h-12 items-center gap-2 border-b border-border bg-card/80 px-3">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  <ExternalEditorOpenMenu
                    availableEditors={props.availableEditors}
                    connectionUrl={inputProps.connectionUrl}
                    gitCwd={props.gitCwd}
                    keybindings={props.keybindings}
                  />
                  {activeWorktreePath ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-border/60 bg-background/70 px-2.5 py-1 text-[10.5px] font-medium text-foreground/76"
                      title={activeWorktreePath}
                    >
                      <GitForkIcon className="size-3 shrink-0 text-muted-foreground/80" />
                      <span>Worktree</span>
                    </span>
                  ) : null}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {canDetachEditor ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="size-7 shrink-0 rounded-lg text-muted-foreground/76 hover:bg-accent hover:text-foreground"
                            onClick={() => void detachEditor()}
                            aria-label="Detach editor"
                          >
                            <ExternalLinkIcon className="size-3.5" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="bottom">Detach editor</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 shrink-0 rounded-lg text-muted-foreground/76 hover:bg-accent hover:text-foreground"
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
                    title="New File"
                  >
                    <FilePlus2Icon className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 shrink-0 rounded-lg text-muted-foreground/76 hover:bg-accent hover:text-foreground"
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
                    title="New Folder"
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              {sidebarMode === "explorer" || sidebarMode === "search" ? (
                <>
                  <div className="border-b border-border/70 bg-background/35 px-2.5 py-2.5">
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                      <Input
                        ref={treeSearchInputRef}
                        nativeInput
                        value={treeSearch}
                        onChange={(event) => setTreeSearch(event.target.value)}
                        placeholder="Search files or content"
                        className="h-8 rounded-lg border-border/60 bg-background/82 pl-7 text-[12px] shadow-none focus-within:border-primary/45 focus-within:bg-background"
                        size="sm"
                        type="search"
                      />
                    </div>
                  </div>
                  <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-transparent px-3 text-[11px]">
                    <ChevronDownIcon
                      className="size-3.5 shrink-0 text-muted-foreground/74"
                      strokeWidth={2}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                      {searchMode ? "Search results" : "Files"}
                    </span>
                    {workspaceTreeQuery.data?.truncated ? (
                      <span className="shrink-0 text-[10px] font-semibold tracking-[0.12em] text-amber-600 uppercase">
                        Partial index
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[10px] font-medium text-muted-foreground/76">
                      {searchMode ? explorerRows.length : workspaceFileCount}
                    </span>
                  </div>
                  <div
                    ref={treeScrollRef}
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
                      <div className="space-y-1 px-2 py-2">
                        {Array.from({ length: 10 }, (_, index) => (
                          <div
                            key={index}
                            className="h-[22px] rounded-md bg-foreground/5"
                            style={{ opacity: 1 - index * 0.06 }}
                          />
                        ))}
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
                                  onDropEntry={(sourcePath, targetParentPath) => {
                                    moveExplorerEntry(sourcePath, targetParentPath);
                                  }}
                                  onFocusEntry={setSelectedEntryPath}
                                  onHoverDropTarget={setDragTargetParentPath}
                                  onOpenFile={handleOpenFile}
                                  onOpenRowContextMenu={(entry, position) => {
                                    void openExplorerContextMenu(entry, position);
                                  }}
                                  onSelectEntry={setSelectedEntryPath}
                                  onToggleDirectory={(directoryPath) =>
                                    toggleDirectory(props.threadId, directoryPath)
                                  }
                                  resolvedTheme={resolvedTheme}
                                  row={row.row}
                                  searchMode={searchMode}
                                  selectedEntryPath={selectedEntryPath}
                                />
                              ) : (
                                <InlineExplorerRow
                                  depth={row.depth}
                                  inputRef={entryDialogInputRef}
                                  onCancel={cancelInlineEntry}
                                  onChangeValue={(value) =>
                                    setInlineEntryState((current) =>
                                      current ? { ...current, value } : current,
                                    )
                                  }
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
              ) : sidebarMode === "source-control" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-transparent px-3 text-[11px]">
                    <GitBranchIcon className="size-3.5 text-muted-foreground/74" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                      Source Control
                    </span>
                    <span className="text-[10px] text-muted-foreground/76">
                      {changedFiles.length}
                    </span>
                  </div>
                  {changedFiles.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <GitBranchIcon className="mx-auto mb-2 size-5 text-muted-foreground/45" />
                      No working tree changes.
                    </div>
                  ) : (
                    <div className="py-1.5">
                      {changedFiles.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className="group mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-muted-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() => handleOpenFile(file.path, false)}
                        >
                          <VscodeEntryIcon
                            pathValue={file.path}
                            kind="file"
                            theme={resolvedTheme}
                            className="size-4"
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
                  )}
                </div>
              ) : sidebarMode === "notes" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="flex h-8 items-center gap-1.5 border-b border-border/70 bg-transparent px-3 text-[11px]">
                    <MessageSquareTextIcon className="size-3.5 text-muted-foreground/74" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
                      Agent Notes
                    </span>
                    <span className="text-[10px] text-muted-foreground/76">
                      {openCodeCommentCount + queuedWorkspaceContexts.length}
                    </span>
                  </div>
                  {queuedWorkspaceContexts.length === 0 && openCodeCommentCount === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                      <MessageSquareTextIcon className="mx-auto mb-2 size-5 text-muted-foreground/45" />
                      Select code to queue context or add a file/range comment.
                    </div>
                  ) : (
                    <div className="space-y-2 p-2">
                      {queuedWorkspaceContexts.map((entry) => (
                        <div
                          key={entry.id}
                          className="overflow-hidden rounded-xl border border-primary/20 bg-primary/6"
                        >
                          <div className="flex items-start gap-2 p-2">
                            <CircleDotIcon className="mt-0.5 size-3.5 text-primary" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[11px] font-semibold text-foreground">
                                {entry.context.relativePath}:{entry.context.range.startLine + 1}-
                                {entry.context.range.endLine + 1}
                              </p>
                              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] text-muted-foreground">
                                {entry.prompt}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                      {codeComments
                        .filter((comment) => comment.status !== "resolved")
                        .map((comment) => (
                          <div
                            key={comment.id}
                            className="overflow-hidden rounded-xl border border-border/60 bg-background/72"
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
                                <p className="mt-1 text-[11px] text-foreground/84">
                                  {comment.body}
                                </p>
                                <div className="mt-2 flex gap-1">
                                  <button
                                    type="button"
                                    className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/15"
                                    onClick={() =>
                                      updateCodeCommentStatus(props.threadId, comment.id, "queued")
                                    }
                                  >
                                    Queue
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md bg-foreground/8 px-1.5 py-0.5 text-[10px] hover:bg-foreground/12"
                                    onClick={() =>
                                      updateCodeCommentStatus(
                                        props.threadId,
                                        comment.id,
                                        "resolved",
                                      )
                                    }
                                  >
                                    Resolve
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                                    onClick={() => removeCodeComment(props.threadId, comment.id)}
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
                      <div className="mx-auto mb-2 flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/70">
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
                              "overflow-hidden rounded-[8px] border border-border/65 bg-background/52",
                              isActiveFile && "border-primary/35 bg-primary/[0.05]",
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

            <div
              aria-label="Resize workspace sidebar"
              role="separator"
              aria-orientation="vertical"
              className="group relative cursor-col-resize bg-background hover:bg-accent"
              onPointerDown={handleTreeResizeStart}
              onPointerMove={handleTreeResizeMove}
              onPointerUp={handleTreeResizeEnd}
              onPointerCancel={handleTreeResizeEnd}
            >
              <div className="mx-auto h-full w-px bg-border transition-colors group-hover:bg-border" />
            </div>
          </>
        ) : null}

        <section className="min-h-0 min-w-0 overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-col">
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
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className="size-7 rounded-lg text-muted-foreground/72 hover:bg-accent hover:text-foreground"
                                    onClick={() => setExplorerOpen(props.threadId, !explorerOpen)}
                                    title={
                                      explorerOpen
                                        ? "Collapse workspace explorer"
                                        : "Expand workspace explorer"
                                    }
                                  >
                                    {explorerOpen ? (
                                      <IconLayoutSidebarFilled className="size-3.5" />
                                    ) : (
                                      <IconLayoutSidebar className="size-3.5" />
                                    )}
                                  </Button>
                                </>
                              ) : undefined
                            }
                            connectionUrl={inputProps.connectionUrl}
                            codeComments={codeComments}
                            diagnosticsCwd={diagnosticsCwd}
                            dirtyFilePaths={activeDirtyPaths}
                            draftsByFilePath={draftsByFilePath}
                            editorOptions={editorOptions}
                            gitCwd={props.gitCwd}
                            onAddCodeComment={handleAddCodeComment}
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
                            onSetActiveFile={(paneId, filePath) =>
                              setActiveFile(props.threadId, filePath, paneId)
                            }
                            onSplitPane={(paneId) => handleSplitPane(paneId, undefined, "right")}
                            onSplitPaneDown={(paneId) => handleSplitPane(paneId, undefined, "down")}
                            onUpdateDraft={(filePath, contents) =>
                              updateDraft(props.threadId, filePath, contents)
                            }
                            monacoTheme={monacoTheme}
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
                          />
                          {paneIndex < row.panes.length - 1 ? (
                            <div
                              aria-label={`Resize between editor windows ${paneIndex + 1} and ${paneIndex + 2}`}
                              role="separator"
                              aria-orientation="vertical"
                              className="group relative z-10 -mx-px flex w-2 shrink-0 cursor-col-resize items-center justify-center touch-none select-none"
                              onPointerDown={handlePaneResizeStart(
                                row.id,
                                paneIndex,
                                row.paneRatios,
                              )}
                              onPointerMove={handlePaneResizeMove}
                              onPointerUp={handlePaneResizeEnd}
                              onPointerCancel={handlePaneResizeEnd}
                            >
                              <div className="h-full w-px bg-border/55 transition-colors group-hover:bg-foreground/30" />
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  {rowIndex < layoutRows.length - 1 ? (
                    <div
                      aria-label={`Resize between editor rows ${rowIndex + 1} and ${rowIndex + 2}`}
                      role="separator"
                      aria-orientation="horizontal"
                      className="group relative z-10 -my-px flex h-2 shrink-0 cursor-row-resize items-center justify-center touch-none select-none"
                      onPointerDown={handleRowResizeStart(rowIndex)}
                      onPointerMove={handleRowResizeMove}
                      onPointerUp={handleRowResizeEnd}
                      onPointerCancel={handleRowResizeEnd}
                    >
                      <div className="h-px w-full bg-border/55 transition-colors group-hover:bg-foreground/30" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
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
                <DiffEditor
                  height={WORKSPACE_FILE_CONFLICT_DIFF_HEIGHT}
                  original={saveConflict.currentContents}
                  modified={saveConflict.localContents}
                  theme={monacoTheme}
                  options={diffEditorOptions}
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

const MemoizedThreadWorkspaceEditor = memo(ThreadWorkspaceEditor);
MemoizedThreadWorkspaceEditor.displayName = "ThreadWorkspaceEditor";

export default MemoizedThreadWorkspaceEditor;
