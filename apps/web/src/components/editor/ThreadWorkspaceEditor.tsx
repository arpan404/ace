import { loader } from "@monaco-editor/react";
import type {
  EditorId,
  ProjectEntry,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BugIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  Plus,
  SearchIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
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
  MAX_THREAD_EDITOR_PANES,
  selectThreadEditorState,
  useEditorStateStore,
} from "~/editorStateStore";
import { isElectron } from "~/env";
import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { normalizePaneRatios, resizePaneRatios } from "~/lib/paneRatios";
import { projectListTreeQueryOptions, projectQueryKeys } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { basenameOfPath } from "~/vscode-icons";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";

import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { OpenInPicker } from "../chat/OpenInPicker";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarTrigger } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TopBarCluster, interleaveTopBarItems } from "../thread/TopBarCluster";
import WorkspaceEditorPane from "./WorkspaceEditorPane";
import { WorkspaceModeToggle } from "./WorkspaceModeToggle";

let monacoConfigured = false;
const EMPTY_PROJECT_ENTRIES: readonly ProjectEntry[] = [];

function ensureMonacoConfigured() {
  if (monacoConfigured) {
    return;
  }

  const environment = {
    getWorker(_: string, label: string) {
      switch (label) {
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "json":
          return new jsonWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  Object.assign(globalThis as object, {
    MonacoEnvironment: environment,
  });
  loader.config({ monaco });
  monaco.editor.defineTheme("t3code-carbon", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5c7084" },
      { token: "keyword", foreground: "f7a267" },
      { token: "string", foreground: "8dc891" },
    ],
    colors: {},
  });
  monaco.editor.defineTheme("t3code-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7b8793" },
      { token: "keyword", foreground: "9f4f1d" },
      { token: "string", foreground: "2a6b4b" },
    ],
    colors: {},
  });
  monacoConfigured = true;
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

const FileTreeRow = memo(function FileTreeRow(props: {
  activeFilePaths: ReadonlySet<string>;
  expandedDirectoryPaths: ReadonlySet<string>;
  focusedFilePath: string | null;
  onOpenFile: (filePath: string, openInNewPane: boolean) => void;
  onToggleDirectory: (directoryPath: string) => void;
  openFilePaths: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  row: TreeRow;
  searchMode: boolean;
}) {
  const isFocused = props.focusedFilePath === props.row.entry.path;
  const isOpen = props.openFilePaths.has(props.row.entry.path);
  const isActiveElsewhere = props.activeFilePaths.has(props.row.entry.path);
  const isExpanded =
    props.row.kind === "directory" && props.expandedDirectoryPaths.has(props.row.entry.path);

  return (
    <button
      type="button"
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
        isFocused
          ? "bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]"
          : isOpen
            ? "bg-foreground/[0.04] text-foreground"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      style={{
        paddingLeft: `${props.searchMode ? 8 : 8 + props.row.depth * 14}px`,
      }}
      onClick={(event) => {
        if (props.row.kind === "directory") {
          props.onToggleDirectory(props.row.entry.path);
          return;
        }
        props.onOpenFile(props.row.entry.path, event.altKey || event.metaKey);
      }}
      title={
        props.row.kind === "file"
          ? `${props.row.entry.path} • Option-click to open in a new window`
          : props.row.entry.path
      }
    >
      {props.row.kind === "directory" ? (
        props.row.hasChildren ? (
          isExpanded ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
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
        className="size-4"
      />
      <span className="min-w-0 flex-1 truncate font-medium">{props.row.name}</span>
      {props.searchMode && props.row.entry.parentPath ? (
        <span className="min-w-0 max-w-[34%] truncate text-[11px] text-muted-foreground/70">
          {props.row.entry.parentPath}
        </span>
      ) : null}
      {props.row.kind === "file" && isOpen ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isFocused ? "bg-primary" : isActiveElsewhere ? "bg-sky-500" : "bg-muted-foreground/60",
          )}
        />
      ) : null}
    </button>
  );
});

function WorkspaceSignalCard(props: {
  active?: boolean;
  detail: string;
  icon: ReactNode;
  label: string;
  resolvedTheme: "light" | "dark";
  value: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] transition-colors cursor-default",
        props.resolvedTheme === "dark"
          ? props.active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          : props.active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      title={props.detail}
    >
      <div className="flex shrink-0 items-center justify-center opacity-70">{props.icon}</div>
      <span className="font-semibold tracking-[0.06em] uppercase opacity-80">{props.label}</span>
      <span className="text-foreground opacity-90">{props.value}</span>
    </div>
  );
}

export default function ThreadWorkspaceEditor(props: {
  activeProjectScripts: ProjectScript[] | undefined;
  activeThreadTitle: string;
  availableEditors: ReadonlyArray<EditorId>;
  browserAvailable: boolean;
  browserDevToolsOpen: boolean;
  browserOpen: boolean;
  browserToggleShortcutLabel: string | null;
  diffOpen: boolean;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  isGitRepo: boolean;
  keybindings: ResolvedKeybindingsConfig;
  mode: ThreadWorkspaceMode;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onCloseBrowser: () => void;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
  onOpenBrowser: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onToggleDiff: () => void;
  onToggleTerminal: () => void;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  preferredScriptId: string | null;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  threadId: ThreadId;
  workspaceName: string | undefined;
}) {
  ensureMonacoConfigured();

  const { resolvedTheme } = useTheme();
  const editorSettings = useSettings((settings) => ({
    lineNumbers: settings.editorLineNumbers,
    minimap: settings.editorMinimap,
    renderWhitespace: settings.editorRenderWhitespace,
    stickyScroll: settings.editorStickyScroll,
    suggestions: settings.editorSuggestions,
    wordWrap: settings.editorWordWrap,
  }));
  const queryClient = useQueryClient();
  const api = readNativeApi();
  const [treeSearch, setTreeSearch] = useState("");
  const deferredTreeSearch = useDeferredValue(treeSearch.trim().toLowerCase());
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const paneGroupRef = useRef<HTMLDivElement | null>(null);
  const closeFile = useEditorStateStore((state) => state.closeFile);
  const closePane = useEditorStateStore((state) => state.closePane);
  const discardDraft = useEditorStateStore((state) => state.discardDraft);
  const hydrateFile = useEditorStateStore((state) => state.hydrateFile);
  const markFileSaved = useEditorStateStore((state) => state.markFileSaved);
  const moveFile = useEditorStateStore((state) => state.moveFile);
  const openFile = useEditorStateStore((state) => state.openFile);
  const setActiveFile = useEditorStateStore((state) => state.setActiveFile);
  const setActivePane = useEditorStateStore((state) => state.setActivePane);
  const setPaneRatios = useEditorStateStore((state) => state.setPaneRatios);
  const setTreeWidth = useEditorStateStore((state) => state.setTreeWidth);
  const splitPane = useEditorStateStore((state) => state.splitPane);
  const syncTree = useEditorStateStore((state) => state.syncTree);
  const toggleDirectory = useEditorStateStore((state) => state.toggleDirectory);
  const updateDraft = useEditorStateStore((state) => state.updateDraft);
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
  const { activePaneId, draftsByFilePath, expandedDirectoryPaths, paneRatios, panes, treeWidth } =
    editorState;
  const activePane = useMemo(
    () => panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null,
    [activePaneId, panes],
  );
  const editorOptions = useMemo(
    () => ({
      acceptSuggestionOnCommitCharacter: editorSettings.suggestions,
      acceptSuggestionOnEnter: editorSettings.suggestions ? ("on" as const) : ("off" as const),
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      cursorBlinking: "smooth" as const,
      fontLigatures: true,
      fontSize: 13.5,
      guides: {
        bracketPairs: true,
        highlightActiveBracketPair: true,
        indentation: true,
      },
      inlineSuggest: { enabled: editorSettings.suggestions },
      lineNumbers: editorSettings.lineNumbers,
      minimap: { enabled: editorSettings.minimap },
      padding: { top: 12, bottom: 24 },
      parameterHints: { enabled: editorSettings.suggestions },
      quickSuggestions: editorSettings.suggestions,
      renderLineHighlightOnlyWhenFocus: true,
      renderWhitespace: editorSettings.renderWhitespace ? ("all" as const) : ("none" as const),
      roundedSelection: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      snippetSuggestions: editorSettings.suggestions ? ("inline" as const) : ("none" as const),
      stickyScroll: { enabled: editorSettings.stickyScroll },
      suggestOnTriggerCharacters: editorSettings.suggestions,
      tabCompletion: editorSettings.suggestions ? ("on" as const) : ("off" as const),
      tabSize: 2,
      wordBasedSuggestions: editorSettings.suggestions
        ? ("currentDocument" as const)
        : ("off" as const),
      wordWrap: editorSettings.wordWrap ? ("on" as const) : ("off" as const),
    }),
    [editorSettings],
  );

  const workspaceTreeQuery = useQuery(
    projectListTreeQueryOptions({
      cwd: props.gitCwd,
    }),
  );
  const treeEntries = workspaceTreeQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  useEffect(() => {
    if (treeEntries.length === 0) {
      return;
    }
    syncTree(
      props.threadId,
      treeEntries.map((entry) => entry.path),
    );
  }, [props.threadId, syncTree, treeEntries]);

  const hasAnyOpenFile = panes.some((pane) => pane.openFilePaths.length > 0);
  useEffect(() => {
    if (hasAnyOpenFile || treeEntries.length === 0 || activePane?.id === undefined) {
      return;
    }
    const firstFile = treeEntries.find((entry) => entry.kind === "file");
    if (firstFile) {
      openFile(props.threadId, firstFile.path, activePane.id);
    }
  }, [activePane?.id, hasAnyOpenFile, openFile, props.threadId, treeEntries]);

  const saveMutation = useMutation({
    mutationFn: async (input: { contents: string; relativePath: string }) => {
      if (!api || !props.gitCwd) {
        throw new Error("Workspace editor is unavailable.");
      }
      return api.projects.writeFile({
        contents: input.contents,
        cwd: props.gitCwd,
        relativePath: input.relativePath,
      });
    },
    onError: (error, variables) => {
      toastManager.add({
        description:
          error instanceof Error ? error.message : `Failed to save ${variables.relativePath}.`,
        title: "Could not save file",
        type: "error",
      });
    },
    onSuccess: (_result, variables) => {
      markFileSaved(props.threadId, variables.relativePath, variables.contents);
      queryClient.setQueryData(projectQueryKeys.readFile(props.gitCwd, variables.relativePath), {
        contents: variables.contents,
        relativePath: variables.relativePath,
        sizeBytes: new Blob([variables.contents]).size,
      });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listTree(props.gitCwd) });
      toastManager.add({
        description: variables.relativePath,
        title: "File saved",
        type: "success",
      });
    },
  });

  const handleSaveFile = useCallback(
    (relativePath: string, contents: string) => {
      if (saveMutation.isPending) {
        return;
      }
      void saveMutation.mutate({ contents, relativePath });
    },
    [saveMutation],
  );
  const handleHydrateFile = useCallback(
    (filePath: string, contents: string) => {
      hydrateFile(props.threadId, filePath, contents);
    },
    [hydrateFile, props.threadId],
  );

  const normalizedPaneRatios = useMemo(
    () => normalizePaneRatios(paneRatios, panes.length),
    [paneRatios, panes.length],
  );

  const activeDirtyPaths = useMemo(
    () =>
      new Set(
        Object.entries(draftsByFilePath)
          .filter(([, draft]) => draft.draftContents !== draft.savedContents)
          .map(([path]) => path),
      ),
    [draftsByFilePath],
  );

  const openFilePaths = useMemo(
    () => new Set(panes.flatMap((pane) => pane.openFilePaths)),
    [panes],
  );
  const activeFilePaths = useMemo(
    () =>
      panes
        .map((pane) => pane.activeFilePath)
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    [panes],
  );
  const activeFilePathSet = useMemo(() => new Set(activeFilePaths), [activeFilePaths]);
  const activeAncestorDirectories = useMemo(
    () => Array.from(new Set(activeFilePaths.flatMap((path) => collectAncestorDirectories(path)))),
    [activeFilePaths],
  );

  const visibleRows = useMemo(() => {
    if (deferredTreeSearch.length > 0) {
      return treeEntries
        .filter((entry) => entry.path.toLowerCase().includes(deferredTreeSearch))
        .toSorted(compareProjectEntries)
        .map<TreeRow>((entry) => ({
          depth: 0,
          entry,
          hasChildren: false,
          kind: entry.kind,
          name: basenameOfPath(entry.path),
        }));
    }

    return buildTreeRows(
      treeEntries,
      new Set([...expandedDirectoryPaths, ...activeAncestorDirectories]),
    );
  }, [activeAncestorDirectories, deferredTreeSearch, expandedDirectoryPaths, treeEntries]);

  const expandedDirectoryPathSet = useMemo(
    () => new Set([...expandedDirectoryPaths, ...activeAncestorDirectories]),
    [activeAncestorDirectories, expandedDirectoryPaths],
  );

  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
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
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart = useCallback(
    (dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      paneResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        startRatios: normalizedPaneRatios,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [normalizedPaneRatios],
  );
  const handlePaneResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = paneResizeStateRef.current;
      const container = paneGroupRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      setPaneRatios(
        props.threadId,
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

  const workspaceFileCount = useMemo(
    () => treeEntries.filter((entry) => entry.kind === "file").length,
    [treeEntries],
  );

  const handleSplitPane = useCallback(
    (paneId?: string, filePath?: string) => {
      const createdPaneId = splitPane(props.threadId, {
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
  const handleRetryActiveFile = useCallback(() => {
    if (!activePane?.activeFilePath) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: projectQueryKeys.readFile(props.gitCwd, activePane.activeFilePath),
    });
  }, [activePane?.activeFilePath, props.gitCwd, queryClient]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !activePane) {
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

      if (command === "editor.split") {
        event.preventDefault();
        event.stopPropagation();
        handleSplitPane(activePane.id);
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
        const currentIndex = panes.findIndex((pane) => pane.id === activePane.id);
        if (currentIndex < 0) {
          return;
        }
        const offset = command === "editor.focusNextWindow" ? 1 : -1;
        const nextPane = panes[(currentIndex + offset + panes.length) % panes.length];
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
    handleSplitPane,
    moveFile,
    panes,
    props.browserOpen,
    props.keybindings,
    props.terminalOpen,
    props.threadId,
    setActiveFile,
    setActivePane,
  ]);

  const editorShortcutLabelOptions = useMemo(
    () => ({
      context: {
        browserOpen: props.browserOpen,
        editorFocus: true,
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
      },
    }),
    [props.browserOpen, props.terminalOpen],
  );
  const splitWindowShortcutLabel = useMemo(
    () => shortcutLabelForCommand(props.keybindings, "editor.split", editorShortcutLabelOptions),
    [editorShortcutLabelOptions, props.keybindings],
  );
  const nextWindowShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        props.keybindings,
        "editor.focusNextWindow",
        editorShortcutLabelOptions,
      ),
    [editorShortcutLabelOptions, props.keybindings],
  );
  const previousWindowShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(
        props.keybindings,
        "editor.focusPreviousWindow",
        editorShortcutLabelOptions,
      ),
    [editorShortcutLabelOptions, props.keybindings],
  );

  const workspaceSignals = useMemo(
    () => [
      {
        active: deferredTreeSearch.length > 0,
        detail:
          deferredTreeSearch.length > 0
            ? `${visibleRows.length} matches in the tree`
            : workspaceTreeQuery.data?.truncated
              ? "Project tree is truncated for performance"
              : "Full project tree is available",
        icon: <FolderIcon className="size-4" />,
        label: "Explorer",
        value: `${workspaceFileCount} files`,
      },
      {
        active: panes.length > 1,
        detail:
          activePane?.activeFilePath !== null && activePane?.activeFilePath !== undefined
            ? `Focused on ${basenameOfPath(activePane.activeFilePath)}${
                nextWindowShortcutLabel || previousWindowShortcutLabel
                  ? ` · ${[previousWindowShortcutLabel, nextWindowShortcutLabel]
                      .filter(Boolean)
                      .join(" / ")}`
                  : ""
              }`
            : "New files route into the focused window",
        icon: <Columns2Icon className="size-4" />,
        label: "Windows",
        value: `${panes.length}/${MAX_THREAD_EDITOR_PANES}`,
      },
      {
        active: props.terminalOpen,
        detail: props.terminalAvailable
          ? "Shell sessions stay attached below the workspace"
          : "Requires an active project",
        icon: <TerminalSquareIcon className="size-4" />,
        label: "Terminal",
        value: props.terminalAvailable ? (props.terminalOpen ? "Open" : "Closed") : "Unavailable",
      },
      {
        active: props.browserOpen,
        detail: props.browserAvailable
          ? "Single-click to dock docs or app UIs beside code"
          : "Available in Electron workspaces",
        icon: <GlobeIcon className="size-4" />,
        label: "Browser",
        value: props.browserAvailable ? (props.browserOpen ? "Open" : "Closed") : "Unavailable",
      },
      {
        active: props.diffOpen,
        detail: props.isGitRepo
          ? "Thread diffs stay docked beside the workspace"
          : "Requires a git workspace",
        icon: <DiffIcon className="size-4" />,
        label: "Diff",
        value: props.isGitRepo ? (props.diffOpen ? "Open" : "Closed") : "Unavailable",
      },
    ],
    [
      activePane?.activeFilePath,
      deferredTreeSearch.length,
      panes.length,
      props.browserAvailable,
      props.browserOpen,
      props.diffOpen,
      props.isGitRepo,
      props.terminalAvailable,
      props.terminalOpen,
      nextWindowShortcutLabel,
      previousWindowShortcutLabel,
      visibleRows.length,
      workspaceFileCount,
      workspaceTreeQuery.data?.truncated,
    ],
  );

  const workspaceActionItems: ReactNode[] = [
    props.activeProjectScripts ? (
      <ProjectScriptsControl
        key="scripts"
        scripts={props.activeProjectScripts}
        keybindings={props.keybindings}
        preferredScriptId={props.preferredScriptId}
        onRunScript={props.onRunProjectScript}
        onAddScript={props.onAddProjectScript}
        onUpdateScript={props.onUpdateProjectScript}
        onDeleteScript={props.onDeleteProjectScript}
      />
    ) : null,
    props.workspaceName ? (
      <OpenInPicker
        key="open-in"
        keybindings={props.keybindings}
        availableEditors={props.availableEditors}
        openInCwd={props.gitCwd}
      />
    ) : null,
    props.workspaceName ? (
      <GitActionsControl key="git" gitCwd={props.gitCwd} activeThreadId={props.threadId} />
    ) : null,
  ];

  const workspaceActionNodes = interleaveTopBarItems(workspaceActionItems);
  const utilityItems = interleaveTopBarItems([
    <Tooltip key="split-window">
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className="rounded-xl"
            onClick={() => handleSplitPane(activePane?.id)}
            disabled={panes.length >= MAX_THREAD_EDITOR_PANES}
          >
            <Plus className="size-3.5" />
            Window
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {panes.length >= MAX_THREAD_EDITOR_PANES
          ? `Up to ${MAX_THREAD_EDITOR_PANES} editor windows are supported in this milestone.`
          : splitWindowShortcutLabel
            ? `Split the focused editor into a new window (${splitWindowShortcutLabel})`
            : "Split the focused editor into a new window"}
      </TooltipPopup>
    </Tooltip>,
    panes.length > 1 && activePane ? (
      <Tooltip key="close-window">
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="rounded-xl"
              onClick={() => closePane(props.threadId, activePane.id)}
            >
              <XIcon className="size-3.5" />
              Close window
            </Button>
          }
        />
        <TooltipPopup side="bottom">Close the focused editor window</TooltipPopup>
      </Tooltip>
    ) : null,
    <Tooltip key="browser">
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 rounded-xl"
            pressed={props.browserOpen}
            onPressedChange={(pressed) => {
              if (pressed) {
                props.onOpenBrowser();
                return;
              }
              props.onCloseBrowser();
            }}
            aria-label={props.browserOpen ? "Close in-app browser" : "Open in-app browser"}
            variant="default"
            size="xs"
            disabled={!props.browserAvailable}
          >
            <span className="relative flex items-center justify-center">
              <GlobeIcon className="size-3" />
              {props.browserOpen && props.browserDevToolsOpen ? (
                <span className="absolute -top-1 -right-1 flex size-3 items-center justify-center rounded-full border border-background bg-amber-500 text-amber-950 shadow-sm">
                  <BugIcon className="size-2" />
                </span>
              ) : null}
            </span>
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!props.browserAvailable
          ? "Browser is available in Electron workspaces."
          : props.browserOpen
            ? props.browserToggleShortcutLabel
              ? `${props.browserDevToolsOpen ? "Close in-app browser · DevTools open" : "Close in-app browser"} (${props.browserToggleShortcutLabel})`
              : props.browserDevToolsOpen
                ? "Close in-app browser · DevTools open"
                : "Close in-app browser"
            : props.browserToggleShortcutLabel
              ? `Open in-app browser (${props.browserToggleShortcutLabel})`
              : "Open in-app browser"}
      </TooltipPopup>
    </Tooltip>,
    <Tooltip key="terminal">
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 rounded-xl"
            pressed={props.terminalOpen}
            onPressedChange={props.onToggleTerminal}
            aria-label="Toggle terminal drawer"
            variant="default"
            size="xs"
            disabled={!props.terminalAvailable}
          >
            <TerminalSquareIcon className="size-3" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!props.terminalAvailable
          ? "Terminal is unavailable until this thread has an active project."
          : props.terminalToggleShortcutLabel
            ? `Toggle terminal drawer (${props.terminalToggleShortcutLabel})`
            : "Toggle terminal drawer"}
      </TooltipPopup>
    </Tooltip>,
    <Tooltip key="diff">
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 rounded-xl"
            pressed={props.diffOpen}
            onPressedChange={props.onToggleDiff}
            aria-label="Toggle diff panel"
            variant="default"
            size="xs"
            disabled={!props.isGitRepo}
          >
            <DiffIcon className="size-3" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {!props.isGitRepo
          ? "Diff panel is unavailable because this project is not a git repository."
          : props.diffToggleShortcutLabel
            ? `Toggle diff panel (${props.diffToggleShortcutLabel})`
            : "Toggle diff panel"}
      </TooltipPopup>
    </Tooltip>,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "border-b border-border/70 bg-background/95 px-3 sm:px-5 supports-[backdrop-filter]:bg-background/84 supports-[backdrop-filter]:backdrop-blur-md",
          isElectron ? "drag-region flex h-13 items-center" : "py-2.5",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="min-w-0 shrink truncate text-sm leading-none font-medium text-foreground"
                title={props.activeThreadTitle}
              >
                {props.activeThreadTitle}
              </span>
              <span className="shrink-0 truncate text-[11px] tracking-[0.18em] text-muted-foreground/80 uppercase">
                Workspace studio
              </span>
            </div>
            {props.workspaceName ? (
              <Badge
                variant="outline"
                size="sm"
                className="min-w-0 max-w-44 shrink overflow-hidden text-muted-foreground/85"
              >
                <span className="min-w-0 truncate">{props.workspaceName}</span>
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <WorkspaceModeToggle mode={props.mode} onModeChange={props.onModeChange} />
            {workspaceActionNodes.length > 0 ? (
              <TopBarCluster>{workspaceActionNodes}</TopBarCluster>
            ) : null}
            <TopBarCluster>{utilityItems}</TopBarCluster>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="relative flex h-full min-h-0 flex-col">
          <div className="border-b border-border/40 px-3 py-1 flex items-center gap-1 bg-muted/10 overflow-x-auto scrollbar-none">
            {workspaceSignals.map((signal) => (
              <WorkspaceSignalCard
                key={signal.label}
                active={signal.active}
                detail={signal.detail}
                icon={signal.icon}
                label={signal.label}
                resolvedTheme={resolvedTheme}
                value={signal.value}
              />
            ))}
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div
              className="grid h-full min-h-0 min-w-0"
              style={{
                gridTemplateColumns: `minmax(220px, ${treeWidth}px) 6px minmax(0, 1fr)`,
              }}
            >
              <aside
                className={cn(
                  "flex min-h-0 min-w-0 flex-col border-r border-border/60",
                  "bg-secondary",
                )}
              >
                <div className="border-b border-border/60 px-3 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <FolderIcon className="size-4 text-muted-foreground/80" />
                    <span className="text-[11px] font-semibold tracking-[0.24em] text-muted-foreground uppercase">
                      Explorer
                    </span>
                    <Badge variant="outline" size="sm" className="ml-auto">
                      {workspaceFileCount}
                    </Badge>
                    {workspaceTreeQuery.data?.truncated ? (
                      <Badge variant="warning" size="sm">
                        Partial
                      </Badge>
                    ) : null}
                  </div>
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                    <Input
                      value={treeSearch}
                      onChange={(event) => setTreeSearch(event.target.value)}
                      placeholder="Filter files"
                      className="pl-8"
                      size="sm"
                      type="search"
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                    Option-click a file to open it in a new editor window without disrupting the
                    focused one.
                  </p>
                </div>

                <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                  {workspaceTreeQuery.isPending ? (
                    <div className="space-y-2 px-1 py-2">
                      {Array.from({ length: 10 }, (_, index) => (
                        <div
                          key={index}
                          className="h-8 rounded-lg bg-foreground/6"
                          style={{ opacity: 1 - index * 0.06 }}
                        />
                      ))}
                    </div>
                  ) : visibleRows.length === 0 ? (
                    <div className="px-2 py-6 text-sm text-muted-foreground">
                      {deferredTreeSearch.length > 0
                        ? "No files match this filter."
                        : "No files found."}
                    </div>
                  ) : (
                    <div
                      className="relative"
                      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                        const row = visibleRows[virtualRow.index];
                        if (!row) {
                          return null;
                        }
                        return (
                          <div
                            key={row.entry.path}
                            className="absolute top-0 left-0 w-full"
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                          >
                            <FileTreeRow
                              activeFilePaths={activeFilePathSet}
                              expandedDirectoryPaths={expandedDirectoryPathSet}
                              focusedFilePath={activePane?.activeFilePath ?? null}
                              onOpenFile={handleOpenFile}
                              onToggleDirectory={(directoryPath) =>
                                toggleDirectory(props.threadId, directoryPath)
                              }
                              openFilePaths={openFilePaths}
                              resolvedTheme={resolvedTheme}
                              row={row}
                              searchMode={deferredTreeSearch.length > 0}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>

              <div
                aria-label="Resize workspace sidebar"
                role="separator"
                aria-orientation="vertical"
                className="relative cursor-col-resize bg-border/80 hover:bg-primary/35"
                onPointerDown={handleTreeResizeStart}
                onPointerMove={handleTreeResizeMove}
                onPointerUp={handleTreeResizeEnd}
                onPointerCancel={handleTreeResizeEnd}
              />

              <section className="min-h-0 min-w-0 overflow-hidden bg-background">
                <div className="flex h-full min-h-0 flex-col">
                  <div ref={paneGroupRef} className="flex min-h-0 flex-1 overflow-hidden">
                    {panes.map((pane, index) => (
                      <div
                        key={pane.id}
                        className="flex min-h-0 min-w-0"
                        style={{
                          flexBasis: 0,
                          flexGrow: normalizedPaneRatios[index] ?? 1,
                          minWidth: 0,
                        }}
                      >
                        <WorkspaceEditorPane
                          active={pane.id === activePaneId}
                          canClosePane={panes.length > 1}
                          canSplitPane={panes.length < MAX_THREAD_EDITOR_PANES}
                          dirtyFilePaths={activeDirtyPaths}
                          draftsByFilePath={draftsByFilePath}
                          editorOptions={editorOptions}
                          gitCwd={props.gitCwd}
                          onCloseFile={(paneId, filePath) =>
                            closeFile(props.threadId, filePath, paneId)
                          }
                          onClosePane={(paneId) => closePane(props.threadId, paneId)}
                          onDiscardDraft={(filePath) => discardDraft(props.threadId, filePath)}
                          onFocusPane={(paneId) => setActivePane(props.threadId, paneId)}
                          onHydrateFile={handleHydrateFile}
                          onMoveFile={(input) => moveFile(props.threadId, input)}
                          onRetryActiveFile={handleRetryActiveFile}
                          onSaveFile={handleSaveFile}
                          onSetActiveFile={(paneId, filePath) =>
                            setActiveFile(props.threadId, filePath, paneId)
                          }
                          onSplitPane={(paneId) => handleSplitPane(paneId)}
                          onUpdateDraft={(filePath, contents) =>
                            updateDraft(props.threadId, filePath, contents)
                          }
                          pane={pane}
                          paneIndex={index}
                          resolvedTheme={resolvedTheme}
                          savingFilePath={
                            saveMutation.isPending
                              ? (saveMutation.variables?.relativePath ?? null)
                              : null
                          }
                        />
                        {index < panes.length - 1 ? (
                          <div
                            aria-label={`Resize between editor windows ${index + 1} and ${index + 2}`}
                            role="separator"
                            aria-orientation="vertical"
                            className="group relative z-10 -mx-[3px] flex w-[6px] shrink-0 cursor-col-resize items-center justify-center touch-none select-none"
                            onPointerDown={handlePaneResizeStart(index)}
                            onPointerMove={handlePaneResizeMove}
                            onPointerUp={handlePaneResizeEnd}
                            onPointerCancel={handlePaneResizeEnd}
                          >
                            <div className="h-full w-[2px] bg-border/40 transition-colors group-hover:bg-primary" />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
