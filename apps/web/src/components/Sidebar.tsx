import { IconSearch, IconSettings } from "@tabler/icons-react";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  LaptopIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  type DesktopUpdateState,
  type FilesystemBrowseResult,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  ProjectId,
  ThreadId,
} from "@ace/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type VirtualItem } from "@tanstack/react-virtual";
import { type SidebarProjectSortOrder } from "@ace/contracts/settings";
import { isElectron } from "../env";
import { reportBackgroundError } from "../lib/async";
import { SIDEBAR_ADD_PROJECT_REQUEST_EVENT } from "../lib/sidebarAddProjectRequest";
import { cn, randomUUID } from "../lib/utils";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  DESKTOP_HEADER_CHROME_CLASS_NAME,
  DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME,
  DESKTOP_HEADER_NAV_CLUSTER_CLASS_NAME,
  MAC_TITLEBAR_LEFT_INSET_STYLE,
} from "../lib/desktopChrome";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { clearPromotedDraftThreads, useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useReactCompilerSafeVirtualizer } from "../hooks/useReactCompilerSafeVirtualizer";
import { getDefaultServerModel } from "../providerModels";
import { useThreadActions } from "../hooks/useThreadActions";
import { ProjectAvatar, ProjectGlyphIcon } from "./ProjectAvatar";
import { PROJECT_ICON_COLOR_OPTIONS, PROJECT_ICON_OPTIONS } from "./projectAvatarOptions";
import { toastManager } from "./ui/toast";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarSearchPaletteDialog } from "./sidebar/SidebarSearchPaletteDialog";
import { ThreadRenameDialog } from "./chat/ThreadRenameDialog";
import { SidebarBoardsSection, type SidebarSplitSortOrder } from "./sidebar/SidebarBoardsSection";
import {
  SidebarSplitPickerDialog,
  type SplitPickerSortOrder,
} from "./sidebar/SidebarSplitPickerDialog";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../lib/desktopUpdate";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { GLASS_BANNER_CLASS_NAME, GLASS_BANNER_WARNING_CLASS_NAME } from "./ui/glass";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Kbd } from "./ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  findExistingProjectByPath,
  inferProjectTitle,
  parentPath,
  resolveProjectPath,
  toBrowseDirectoryPath,
} from "../lib/projectPaths";
import {
  buildRenderedSidebarThreadGroups,
  getProjectSortTimestamp,
  resolveAdjacentThreadId,
  resolveNearbyThreadIds,
  isContextMenuPointerDown,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadOptions,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  shouldUseFallbackSidebarVirtualItems,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
  deriveFallbackSidebarVirtualItems,
} from "../lib/sidebar";
import {
  deriveSidebarLocalProjectThreadGroup,
  EMPTY_SIDEBAR_THREADS,
  type SidebarLocalProjectThreadGroup,
} from "./sidebar/localProjectRenderState";
import { SidebarLocalProjectSection } from "./sidebar/SidebarLocalProjectSection";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { SidebarProjectsSectionHeader } from "./sidebar/SidebarProjectsSectionHeader";
import {
  SortableProjectItem,
  type SortableProjectHandleProps,
} from "./sidebar/SortableProjectItem";
import { SidebarThreadRow } from "./sidebar/SidebarThreadRow";
import { useSidebarCommandPalette } from "./sidebar/useSidebarCommandPalette";
import { useSidebarThreadPrStatus } from "./sidebar/useSidebarThreadPrStatus";
import type {
  RemoteSidebarHostEntry,
  RemoteSidebarProjectEntry,
  RemoteSidebarThreadEntry,
} from "./sidebar/sidebarTypes";
import { hydrateThreadFromCache, readCachedHydratedThread } from "../lib/threadHydrationCache";
import {
  primeThreadTimelineRowsMetadataFromReadModelThread,
  startThreadTimelineRowsOpenPrefetch,
} from "../lib/chat/timelineModelStore";
import { isThreadLiveWorkActive } from "../lib/chat/activeThreadHydration";
import { shouldAvoidSpeculativeWork } from "../lib/resourceProfile";
import { describeHostConnection } from "@ace/shared/hostConnections";
import {
  isHostConnectionActive,
  loadConnectedRemoteHostIds,
  loadRemoteHostInstances,
  normalizeWsUrl,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  splitWsUrlAuthToken,
  type RemoteHostInstance,
} from "../lib/remoteHosts";
import {
  probeRemoteRouteAvailability,
  registerRemoteRoute,
  routeFilesystemBrowseToRemote,
  routeOrchestrationDispatchCommandToRemote,
  routeOrchestrationGetShellSnapshotFromRemote,
  unregisterRemoteRoute,
} from "../lib/remoteWsRouter";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSetting, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import type { Project, SidebarThreadSummary } from "../types";
import { useHostConnectionStore } from "../hostConnectionStore";
import {
  resolveConnectionForThreadId,
  THREAD_ROUTE_CONNECTION_SEARCH_PARAM,
} from "../lib/connectionRouting";
import { buildSingleThreadRouteSearch } from "../lib/chatThreadBoardRouteSearch";
import { buildSidebarBoardListItem } from "../lib/threadBoardList";
import { buildThreadBoardTitle } from "../lib/threadBoardTitle";
import {
  createThreadBoardDragThread,
  decodeThreadBoardDragThread,
  encodeThreadBoardDragThread,
  getThreadBoardDragThreadKey,
  setActiveThreadBoardDrag,
  setThreadBoardDragImage,
  THREAD_BOARD_DRAG_MIME,
  type ThreadBoardDragThread,
} from "../lib/threadBoardDrag";
import {
  orderBoardPanes,
  type ChatThreadBoardSplitState,
  type ChatThreadBoardPaneState,
  useChatThreadBoardStore,
} from "../chatThreadBoardStore";

const sidebarProjectCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  return closestCorners(args);
};
const SIDEBAR_PROJECT_DND_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

const THREAD_REVEAL_STEP = 5;
const SPLIT_REVEAL_STEP = 5;
const SIDEBAR_PROJECT_HEADER_ROW_ESTIMATE_PX = 28;
const SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX = 28;
const SIDEBAR_PROJECT_AUXILIARY_ROW_ESTIMATE_PX = 24;
const SIDEBAR_PROJECT_CHILD_ROW_GAP_PX = 2;
const SIDEBAR_PROJECT_LIST_INITIAL_VIEWPORT_HEIGHT_PX = 720;
const SIDEBAR_PROJECT_LIST_VIRTUALIZER_OVERSCAN = 8;
const REMOTE_HOST_REFRESH_INTERVAL_MS = 20_000;
const REMOTE_HOST_HIDDEN_REFRESH_INTERVAL_MS = 90_000;
const REMOTE_HOST_INITIAL_RESOLVE_DELAY_MS = 1_500;
const REMOTE_SIDEBAR_SNAPSHOT_FETCH_CONCURRENCY = 2;
const REMOTE_SNAPSHOT_BACKGROUND_MERGE_TIMEOUT_MS = 600;
const SIDEBAR_THREAD_PREFETCH_WINDOW = 14;
const SIDEBAR_THREAD_PREFETCH_STORE_HYDRATE_COUNT = 0;
const SIDEBAR_THREAD_PREFETCH_CONCURRENCY = 4;
const SIDEBAR_MOUNTED_THREAD_PREFETCH_LIMIT = 24;
const SIDEBAR_MOUNTED_THREAD_STORE_HYDRATE_COUNT = 0;
const SIDEBAR_SPECULATIVE_PREFETCH_IDLE_TIMEOUT_MS = 2_500;
const SIDEBAR_SPECULATIVE_PREFETCH_FALLBACK_DELAY_MS = 900;

function deriveCurrentSortedActiveThreads(): SidebarThreadSummary[] {
  const activeThreads: SidebarThreadSummary[] = [];
  for (const thread of Object.values(useStore.getState().sidebarThreadsById)) {
    if (thread === undefined || thread.archivedAt !== null) continue;
    activeThreads.push(thread);
  }
  return activeThreads.toSorted(
    (left, right) =>
      Math.max(
        resolveIsoTimestamp(right.latestUserMessageAt ?? undefined),
        resolveIsoTimestamp(right.updatedAt),
        resolveIsoTimestamp(right.createdAt),
      ) -
      Math.max(
        resolveIsoTimestamp(left.latestUserMessageAt ?? undefined),
        resolveIsoTimestamp(left.updatedAt),
        resolveIsoTimestamp(left.createdAt),
      ),
  );
}

function openPrLink(event: MouseEvent<HTMLElement>, prUrl: string): void {
  event.preventDefault();
  event.stopPropagation();

  const api = readNativeApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void api.shell.openExternal(prUrl).catch((error) => {
    toastManager.add({
      type: "error",
      title: "Unable to open PR link",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}

type SplitContextMenuState = {
  position: { x: number; y: number };
  splitId: string;
};
type BoardThreadDragState = {
  activeThread: ThreadBoardDragThread;
  activeThreadKey: string;
  overTargetKey: string | null;
};
type RenderedRemoteSidebarProject = {
  readonly project: RemoteSidebarProjectEntry;
  readonly projectKey: string;
  readonly connectionUrl: string;
  readonly projectExpanded: boolean;
  readonly visibleThreads: readonly RemoteSidebarThreadEntry[];
  readonly hiddenThreadCount: number;
  readonly hasHiddenThreads: boolean;
  readonly canCollapseThreadList: boolean;
};
type ProjectBrowseState = {
  isBrowsing: boolean;
  loadedPath: string | null;
  result: FilesystemBrowseResult | null;
};
type ProjectPickerBrowseUiState = {
  projectBrowseState: ProjectBrowseState;
  activeProjectBrowseIndex: number;
  addProjectError: string | null;
  projectPickerKeyboardNavigationId: number;
};
type ProjectPickerBrowseUiAction =
  | { type: "reset-project-browse-ui" }
  | { type: "project-browse-start"; path: string }
  | {
      type: "project-browse-success";
      path: string;
      result: FilesystemBrowseResult;
    }
  | { type: "project-browse-failure"; path: string; error: string | null }
  | { type: "project-browse-finish" }
  | {
      type: "set-project-browse-state";
      nextState: ProjectBrowseState | ((current: ProjectBrowseState) => ProjectBrowseState);
    }
  | {
      type: "set-active-project-browse-index";
      nextIndex: number | ((current: number) => number);
    }
  | { type: "set-add-project-error"; error: string | null }
  | { type: "bump-keyboard-navigation-id" };
type SidebarProjectListItem =
  | {
      kind: "local";
      key: string;
      projectId: ProjectId;
      renderedThreadCount: number;
      auxiliaryRowCount: number;
      sortable: boolean;
    }
  | {
      kind: "remote";
      key: string;
      renderedProject: RenderedRemoteSidebarProject;
    };
type RemoteThreadRenameTarget = {
  connectionUrl: string;
  project: RemoteSidebarProjectEntry;
  thread: RemoteSidebarThreadEntry;
};
type SidebarEditorState = {
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  projectEditorOpen: boolean;
  editingProjectId: ProjectId | null;
  editingProjectConnectionUrl: string | null;
  editingProjectName: string;
  editingProjectIcon: Project["icon"];
  remoteThreadRenameTarget: RemoteThreadRenameTarget | null;
  remoteThreadRenameTitle: string;
};
type SidebarEditorAction =
  | { type: "clear-thread-rename" }
  | { type: "clear-thread-rename-if-match"; renamingThreadId: ThreadId }
  | { type: "set-renaming-title"; renamingTitle: string }
  | { type: "start-thread-rename"; renamingThreadId: ThreadId; renamingTitle: string }
  | { type: "close-project-editor" }
  | {
      type: "open-project-editor";
      editingProjectConnectionUrl: string;
      editingProjectIcon: Project["icon"];
      editingProjectId: ProjectId;
      editingProjectName: string;
    }
  | { type: "set-editing-project-name"; editingProjectName: string }
  | {
      type: "set-editing-project-icon";
      nextIcon: Project["icon"] | ((current: Project["icon"]) => Project["icon"]);
    }
  | { type: "close-remote-thread-rename" }
  | {
      type: "open-remote-thread-rename";
      remoteThreadRenameTarget: RemoteThreadRenameTarget;
      remoteThreadRenameTitle: string;
    };
type SidebarSplitBoardUiState = {
  splitSortOrder: SidebarSplitSortOrder;
  splitRevealCount: number;
  splitPickerOpen: boolean;
  splitPickerQuery: string;
  splitPickerProjectFilter: string;
  splitPickerSortOrder: SplitPickerSortOrder;
  splitPickerSelectedThreadIds: Set<ThreadId>;
  splitContextMenuState: SplitContextMenuState | null;
  renamingSplitId: string | null;
  renamingSplitTitle: string;
  boardThreadDragState: BoardThreadDragState | null;
};
type SidebarSplitBoardUiAction =
  | { type: "set-split-sort-order"; splitSortOrder: SidebarSplitSortOrder }
  | { type: "set-split-reveal-count"; nextCount: number | ((current: number) => number) }
  | { type: "open-split-picker" }
  | { type: "close-split-picker" }
  | { type: "set-split-picker-open"; splitPickerOpen: boolean }
  | { type: "set-split-picker-query"; splitPickerQuery: string }
  | { type: "set-split-picker-project-filter"; splitPickerProjectFilter: string }
  | { type: "set-split-picker-sort-order"; splitPickerSortOrder: SplitPickerSortOrder }
  | { type: "toggle-split-picker-thread"; threadId: ThreadId }
  | { type: "set-split-context-menu-state"; splitContextMenuState: SplitContextMenuState | null }
  | { type: "start-split-rename"; renamingSplitId: string; renamingSplitTitle: string }
  | { type: "cancel-split-rename" }
  | { type: "set-renaming-split-title"; renamingSplitTitle: string }
  | { type: "set-board-thread-drag-state"; boardThreadDragState: BoardThreadDragState | null }
  | { type: "set-board-thread-drag-over-target"; overTargetKey: string | null };
type SidebarAuxUiState = {
  confirmingArchiveThreadId: ThreadId | null;
  threadRevealCountByProject: Partial<Record<ProjectId, number>>;
  desktopUpdateState: DesktopUpdateState | null;
  remoteSidebarHosts: ReadonlyArray<RemoteSidebarHostEntry>;
  remoteProjectExpandedById: Record<string, boolean>;
  remoteThreadRevealCountByProject: Record<string, number>;
};
type SidebarAuxUiAction =
  | {
      type: "set-confirming-archive-thread-id";
      confirmingArchiveThreadId: ThreadId | null | ((current: ThreadId | null) => ThreadId | null);
    }
  | {
      type: "set-thread-reveal-count-by-project";
      threadRevealCountByProject:
        | Partial<Record<ProjectId, number>>
        | ((current: Partial<Record<ProjectId, number>>) => Partial<Record<ProjectId, number>>);
    }
  | {
      type: "set-desktop-update-state";
      desktopUpdateState:
        | DesktopUpdateState
        | null
        | ((current: DesktopUpdateState | null) => DesktopUpdateState | null);
    }
  | {
      type: "set-remote-sidebar-hosts";
      remoteSidebarHosts:
        | ReadonlyArray<RemoteSidebarHostEntry>
        | ((
            current: ReadonlyArray<RemoteSidebarHostEntry>,
          ) => ReadonlyArray<RemoteSidebarHostEntry>);
    }
  | {
      type: "set-remote-project-expanded-by-id";
      remoteProjectExpandedById:
        | Record<string, boolean>
        | ((current: Record<string, boolean>) => Record<string, boolean>);
    }
  | {
      type: "set-remote-thread-reveal-count-by-project";
      remoteThreadRevealCountByProject:
        | Record<string, number>
        | ((current: Record<string, number>) => Record<string, number>);
    };
const REMOTE_SNAPSHOT_BACKGROUND_MERGE_DELAY_MS = 120;
const EMPTY_PROJECT_BROWSE_STATE: ProjectBrowseState = {
  isBrowsing: false,
  loadedPath: null,
  result: null,
};
const EMPTY_PROJECT_PICKER_BROWSE_UI_STATE: ProjectPickerBrowseUiState = {
  projectBrowseState: EMPTY_PROJECT_BROWSE_STATE,
  activeProjectBrowseIndex: -1,
  addProjectError: null,
  projectPickerKeyboardNavigationId: 0,
};
const EMPTY_SIDEBAR_EDITOR_STATE: SidebarEditorState = {
  renamingThreadId: null,
  renamingTitle: "",
  projectEditorOpen: false,
  editingProjectId: null,
  editingProjectConnectionUrl: null,
  editingProjectName: "",
  editingProjectIcon: null,
  remoteThreadRenameTarget: null,
  remoteThreadRenameTitle: "",
};
const EMPTY_SIDEBAR_SPLIT_BOARD_UI_STATE: SidebarSplitBoardUiState = {
  splitSortOrder: "updated_at",
  splitRevealCount: SPLIT_REVEAL_STEP,
  splitPickerOpen: false,
  splitPickerQuery: "",
  splitPickerProjectFilter: "all",
  splitPickerSortOrder: "recent",
  splitPickerSelectedThreadIds: new Set(),
  splitContextMenuState: null,
  renamingSplitId: null,
  renamingSplitTitle: "",
  boardThreadDragState: null,
};
const EMPTY_SIDEBAR_AUX_UI_STATE: SidebarAuxUiState = {
  confirmingArchiveThreadId: null,
  threadRevealCountByProject: {},
  desktopUpdateState: null,
  remoteSidebarHosts: [],
  remoteProjectExpandedById: {},
  remoteThreadRevealCountByProject: {},
};

function shouldUseProjectPickerHoverSelection(lastKeyboardNavigationAt: number): boolean {
  return Date.now() - lastKeyboardNavigationAt > 500;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createContainsMatcher(query: string): RegExp | null {
  if (query.length === 0) {
    return null;
  }

  return new RegExp(escapeRegExp(query), "i");
}

function projectPickerBrowseUiStateReducer(
  state: ProjectPickerBrowseUiState,
  action: ProjectPickerBrowseUiAction,
): ProjectPickerBrowseUiState {
  switch (action.type) {
    case "reset-project-browse-ui":
      return {
        ...state,
        projectBrowseState: EMPTY_PROJECT_BROWSE_STATE,
        activeProjectBrowseIndex: -1,
        addProjectError: null,
      };
    case "project-browse-start":
      return {
        ...state,
        projectBrowseState: {
          ...state.projectBrowseState,
          isBrowsing: true,
          loadedPath: action.path,
        },
        addProjectError: null,
      };
    case "project-browse-success":
      return {
        ...state,
        projectBrowseState: {
          isBrowsing: true,
          loadedPath: action.path,
          result: action.result,
        },
        activeProjectBrowseIndex: action.result.entries.length > 0 ? 0 : -1,
        addProjectError: null,
      };
    case "project-browse-failure":
      return {
        ...state,
        projectBrowseState: {
          isBrowsing: true,
          loadedPath: action.path,
          result: null,
        },
        activeProjectBrowseIndex: -1,
        addProjectError: action.error,
      };
    case "project-browse-finish":
      return {
        ...state,
        projectBrowseState: {
          ...state.projectBrowseState,
          isBrowsing: false,
        },
      };
    case "set-project-browse-state": {
      const nextState =
        typeof action.nextState === "function"
          ? action.nextState(state.projectBrowseState)
          : action.nextState;
      return state.projectBrowseState === nextState
        ? state
        : {
            ...state,
            projectBrowseState: nextState,
          };
    }
    case "set-active-project-browse-index": {
      const nextIndex =
        typeof action.nextIndex === "function"
          ? action.nextIndex(state.activeProjectBrowseIndex)
          : action.nextIndex;
      return state.activeProjectBrowseIndex === nextIndex
        ? state
        : {
            ...state,
            activeProjectBrowseIndex: nextIndex,
          };
    }
    case "set-add-project-error":
      return state.addProjectError === action.error
        ? state
        : {
            ...state,
            addProjectError: action.error,
          };
    case "bump-keyboard-navigation-id":
      return {
        ...state,
        projectPickerKeyboardNavigationId: state.projectPickerKeyboardNavigationId + 1,
      };
  }
}

function sidebarEditorStateReducer(
  state: SidebarEditorState,
  action: SidebarEditorAction,
): SidebarEditorState {
  switch (action.type) {
    case "clear-thread-rename":
      return {
        ...state,
        renamingThreadId: null,
      };
    case "clear-thread-rename-if-match":
      return state.renamingThreadId !== action.renamingThreadId
        ? state
        : {
            ...state,
            renamingThreadId: null,
          };
    case "set-renaming-title":
      return {
        ...state,
        renamingTitle: action.renamingTitle,
      };
    case "start-thread-rename":
      return {
        ...state,
        renamingThreadId: action.renamingThreadId,
        renamingTitle: action.renamingTitle,
      };
    case "close-project-editor":
      return {
        ...state,
        projectEditorOpen: false,
        editingProjectId: null,
        editingProjectConnectionUrl: null,
        editingProjectName: "",
        editingProjectIcon: null,
      };
    case "open-project-editor":
      return {
        ...state,
        projectEditorOpen: true,
        editingProjectId: action.editingProjectId,
        editingProjectConnectionUrl: action.editingProjectConnectionUrl,
        editingProjectName: action.editingProjectName,
        editingProjectIcon: action.editingProjectIcon,
      };
    case "set-editing-project-name":
      return {
        ...state,
        editingProjectName: action.editingProjectName,
      };
    case "set-editing-project-icon":
      return {
        ...state,
        editingProjectIcon:
          typeof action.nextIcon === "function"
            ? action.nextIcon(state.editingProjectIcon)
            : action.nextIcon,
      };
    case "close-remote-thread-rename":
      return {
        ...state,
        remoteThreadRenameTarget: null,
        remoteThreadRenameTitle: "",
      };
    case "open-remote-thread-rename":
      return {
        ...state,
        remoteThreadRenameTarget: action.remoteThreadRenameTarget,
        remoteThreadRenameTitle: action.remoteThreadRenameTitle,
      };
    default:
      return state;
  }
}

function sidebarSplitBoardUiStateReducer(
  state: SidebarSplitBoardUiState,
  action: SidebarSplitBoardUiAction,
): SidebarSplitBoardUiState {
  switch (action.type) {
    case "set-split-sort-order":
      return {
        ...state,
        splitSortOrder: action.splitSortOrder,
      };
    case "set-split-reveal-count": {
      const nextCount =
        typeof action.nextCount === "function"
          ? action.nextCount(state.splitRevealCount)
          : action.nextCount;
      return state.splitRevealCount === nextCount
        ? state
        : {
            ...state,
            splitRevealCount: nextCount,
          };
    }
    case "open-split-picker":
      return {
        ...state,
        splitPickerOpen: true,
        splitPickerQuery: "",
        splitPickerProjectFilter: "all",
        splitPickerSortOrder: "recent",
        splitPickerSelectedThreadIds: new Set(),
      };
    case "close-split-picker":
      return {
        ...state,
        splitPickerOpen: false,
        splitPickerQuery: "",
        splitPickerProjectFilter: "all",
        splitPickerSortOrder: "recent",
        splitPickerSelectedThreadIds: new Set(),
      };
    case "set-split-picker-open":
      return state.splitPickerOpen === action.splitPickerOpen
        ? state
        : {
            ...state,
            splitPickerOpen: action.splitPickerOpen,
          };
    case "set-split-picker-query":
      return {
        ...state,
        splitPickerQuery: action.splitPickerQuery,
      };
    case "set-split-picker-project-filter":
      return {
        ...state,
        splitPickerProjectFilter: action.splitPickerProjectFilter,
      };
    case "set-split-picker-sort-order":
      return {
        ...state,
        splitPickerSortOrder: action.splitPickerSortOrder,
      };
    case "toggle-split-picker-thread": {
      const next = new Set(state.splitPickerSelectedThreadIds);
      if (next.has(action.threadId)) {
        next.delete(action.threadId);
      } else {
        next.add(action.threadId);
      }
      return {
        ...state,
        splitPickerSelectedThreadIds: next,
      };
    }
    case "set-split-context-menu-state":
      return {
        ...state,
        splitContextMenuState: action.splitContextMenuState,
      };
    case "start-split-rename":
      return {
        ...state,
        renamingSplitId: action.renamingSplitId,
        renamingSplitTitle: action.renamingSplitTitle,
      };
    case "cancel-split-rename":
      return {
        ...state,
        renamingSplitId: null,
        renamingSplitTitle: "",
      };
    case "set-renaming-split-title":
      return {
        ...state,
        renamingSplitTitle: action.renamingSplitTitle,
      };
    case "set-board-thread-drag-state":
      return {
        ...state,
        boardThreadDragState: action.boardThreadDragState,
      };
    case "set-board-thread-drag-over-target":
      return !state.boardThreadDragState ||
        state.boardThreadDragState.overTargetKey === action.overTargetKey
        ? state
        : {
            ...state,
            boardThreadDragState: {
              ...state.boardThreadDragState,
              overTargetKey: action.overTargetKey,
            },
          };
    default:
      return state;
  }
}

function resolveSidebarAuxUiValue<T>(current: T, next: T | ((current: T) => T)): T {
  return typeof next === "function" ? (next as (current: T) => T)(current) : next;
}

function sidebarAuxUiStateReducer(
  state: SidebarAuxUiState,
  action: SidebarAuxUiAction,
): SidebarAuxUiState {
  switch (action.type) {
    case "set-confirming-archive-thread-id": {
      const confirmingArchiveThreadId = resolveSidebarAuxUiValue(
        state.confirmingArchiveThreadId,
        action.confirmingArchiveThreadId,
      );
      return confirmingArchiveThreadId === state.confirmingArchiveThreadId
        ? state
        : { ...state, confirmingArchiveThreadId };
    }
    case "set-thread-reveal-count-by-project": {
      const threadRevealCountByProject = resolveSidebarAuxUiValue(
        state.threadRevealCountByProject,
        action.threadRevealCountByProject,
      );
      return threadRevealCountByProject === state.threadRevealCountByProject
        ? state
        : { ...state, threadRevealCountByProject };
    }
    case "set-desktop-update-state": {
      const desktopUpdateState = resolveSidebarAuxUiValue(
        state.desktopUpdateState,
        action.desktopUpdateState,
      );
      return desktopUpdateState === state.desktopUpdateState
        ? state
        : { ...state, desktopUpdateState };
    }
    case "set-remote-sidebar-hosts": {
      const remoteSidebarHosts = resolveSidebarAuxUiValue(
        state.remoteSidebarHosts,
        action.remoteSidebarHosts,
      );
      return remoteSidebarHosts === state.remoteSidebarHosts
        ? state
        : { ...state, remoteSidebarHosts };
    }
    case "set-remote-project-expanded-by-id": {
      const remoteProjectExpandedById = resolveSidebarAuxUiValue(
        state.remoteProjectExpandedById,
        action.remoteProjectExpandedById,
      );
      return remoteProjectExpandedById === state.remoteProjectExpandedById
        ? state
        : { ...state, remoteProjectExpandedById };
    }
    case "set-remote-thread-reveal-count-by-project": {
      const remoteThreadRevealCountByProject = resolveSidebarAuxUiValue(
        state.remoteThreadRevealCountByProject,
        action.remoteThreadRevealCountByProject,
      );
      return remoteThreadRevealCountByProject === state.remoteThreadRevealCountByProject
        ? state
        : { ...state, remoteThreadRevealCountByProject };
    }
    default:
      return state;
  }
}

function estimateSidebarProjectChildRows(
  threadRowCount: number,
  auxiliaryRowCount: number,
): number {
  const childRowCount = threadRowCount + auxiliaryRowCount;
  if (childRowCount === 0) {
    return 0;
  }
  return (
    threadRowCount * SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX +
    auxiliaryRowCount * SIDEBAR_PROJECT_AUXILIARY_ROW_ESTIMATE_PX +
    (childRowCount - 1) * SIDEBAR_PROJECT_CHILD_ROW_GAP_PX
  );
}

function estimateSidebarProjectListItemSize(item: SidebarProjectListItem | undefined): number {
  if (!item) {
    return SIDEBAR_PROJECT_HEADER_ROW_ESTIMATE_PX;
  }
  if (item.kind === "local") {
    return (
      SIDEBAR_PROJECT_HEADER_ROW_ESTIMATE_PX +
      estimateSidebarProjectChildRows(item.renderedThreadCount, item.auxiliaryRowCount)
    );
  }
  const remoteAuxiliaryRowCount =
    item.renderedProject.projectExpanded && item.renderedProject.visibleThreads.length === 0
      ? 1
      : 0;
  return (
    SIDEBAR_PROJECT_HEADER_ROW_ESTIMATE_PX +
    estimateSidebarProjectChildRows(
      item.renderedProject.visibleThreads.length,
      remoteAuxiliaryRowCount +
        (item.renderedProject.hasHiddenThreads ? 1 : 0) +
        (item.renderedProject.canCollapseThreadList ? 1 : 0),
    )
  );
}

function deriveReactCompilerSafeFallbackSidebarVirtualItems(options: {
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => VirtualItem["key"];
  rowCount: number;
  scrollMargin: number;
  scrollTop: number;
  totalSize: number;
  virtualItems: ReadonlyArray<VirtualItem>;
  viewportHeight: number;
}): VirtualItem[] {
  "use no memo";

  if (
    !shouldUseFallbackSidebarVirtualItems({
      rowCount: options.rowCount,
      scrollMargin: options.scrollMargin,
      scrollTop: options.scrollTop,
      totalSize: options.totalSize,
      viewportHeight: options.viewportHeight,
      virtualItems: options.virtualItems,
    })
  ) {
    return [];
  }

  return deriveFallbackSidebarVirtualItems<VirtualItem["key"]>({
    rowCount: options.rowCount,
    estimateSize: options.estimateSize,
    getItemKey: options.getItemKey,
    overscan: SIDEBAR_PROJECT_LIST_VIRTUALIZER_OVERSCAN,
    scrollMargin: options.scrollMargin,
    scrollTop: options.scrollTop,
    viewportHeight: options.viewportHeight,
    sizeFallback: SIDEBAR_PROJECT_HEADER_ROW_ESTIMATE_PX,
  });
}

function getSidebarProjectListItemLayoutSignature(item: SidebarProjectListItem): string {
  if (item.kind === "local") {
    return [
      item.key,
      "local",
      item.sortable ? "sortable" : "static",
      item.renderedThreadCount,
      item.auxiliaryRowCount,
    ].join(":");
  }
  return [
    item.key,
    "remote",
    item.renderedProject.projectExpanded ? "expanded" : "collapsed",
    item.renderedProject.visibleThreads.length,
    item.renderedProject.hasHiddenThreads ? 1 : 0,
    item.renderedProject.canCollapseThreadList ? 1 : 0,
  ].join(":");
}

function getVirtualProjectRowStyle(virtualRow: VirtualItem, scrollMargin: number): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${virtualRow.start - scrollMargin}px)`,
  };
}

type SidebarThreadHistoryPrefetch = (
  threadId: ThreadId,
  options?: {
    readonly hydrateStore?: boolean;
    readonly prewarmRows?: boolean;
    readonly priority?: "background" | "immediate";
  },
) => void;

type SidebarProjectListRenderItemArgs = {
  item: SidebarProjectListItem;
  measureElement: (element: HTMLElement | null) => void;
  virtualRow: VirtualItem;
  virtualStyle: CSSProperties;
};

function createSidebarProjectScrollMarginStore() {
  let scrollMargin = 0;
  const listeners = new Set<() => void>();

  return {
    getServerSnapshot: () => 0,
    getSnapshot: () => scrollMargin,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (nextScrollMargin: number) => {
      if (Math.abs(scrollMargin - nextScrollMargin) < 0.5) {
        return;
      }
      scrollMargin = nextScrollMargin;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function SidebarProjectVirtualList({
  items,
  layoutMeasureKey,
  layoutSignature,
  localProjectThreadGroupById,
  offsetSourceRef,
  prefetchThreadHistory,
  projectsSectionExpanded,
  renderItem,
  scrollElementRef,
}: {
  readonly items: readonly SidebarProjectListItem[];
  readonly layoutMeasureKey: string;
  readonly layoutSignature: string;
  readonly localProjectThreadGroupById: ReadonlyMap<ProjectId, SidebarLocalProjectThreadGroup>;
  readonly offsetSourceRef: RefObject<HTMLDivElement | null>;
  readonly prefetchThreadHistory: SidebarThreadHistoryPrefetch;
  readonly projectsSectionExpanded: boolean;
  readonly renderItem: (args: SidebarProjectListRenderItemArgs) => ReactNode;
  readonly scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  const projectListRef = useRef<HTMLUListElement | null>(null);
  const scrollMarginFrameRef = useRef<number | null>(null);
  const [scrollMarginStore] = useState(createSidebarProjectScrollMarginStore);
  const scrollMargin = useSyncExternalStore(
    scrollMarginStore.subscribe,
    scrollMarginStore.getSnapshot,
    scrollMarginStore.getServerSnapshot,
  );
  const itemCount = projectsSectionExpanded ? items.length : 0;
  const estimateItemSizeByIndex = (index: number) =>
    estimateSidebarProjectListItemSize(items[index]);
  const getItemKey = (index: number): VirtualItem["key"] => items[index]?.key ?? index;
  const estimatedTotalSize = items.reduce(
    (total, item) => total + estimateSidebarProjectListItemSize(item),
    0,
  );
  const virtualizer = useReactCompilerSafeVirtualizer({
    count: itemCount,
    estimateSize: estimateItemSizeByIndex,
    getItemKey,
    getScrollElement: () => scrollElementRef.current,
    initialRect: { width: 0, height: SIDEBAR_PROJECT_LIST_INITIAL_VIEWPORT_HEIGHT_PX },
    overscan: SIDEBAR_PROJECT_LIST_VIRTUALIZER_OVERSCAN,
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = Math.max(virtualizer.getTotalSize(), estimatedTotalSize);
  const fallbackVirtualRows = deriveReactCompilerSafeFallbackSidebarVirtualItems({
    estimateSize: estimateItemSizeByIndex,
    getItemKey,
    rowCount: itemCount,
    scrollMargin,
    scrollTop: virtualizer.scrollOffset ?? 0,
    totalSize,
    virtualItems: virtualRows,
    viewportHeight:
      virtualizer.scrollRect?.height ?? SIDEBAR_PROJECT_LIST_INITIAL_VIEWPORT_HEIGHT_PX,
  });
  const renderedVirtualRows = fallbackVirtualRows.length > 0 ? fallbackVirtualRows : virtualRows;
  const mountedThreadPrefetchKey = (() => {
    const threadIds: ThreadId[] = [];
    const seenThreadIds = new Set<ThreadId>();
    const pushThreadId = (threadId: ThreadId) => {
      if (
        seenThreadIds.has(threadId) ||
        threadIds.length >= SIDEBAR_MOUNTED_THREAD_PREFETCH_LIMIT
      ) {
        return;
      }
      seenThreadIds.add(threadId);
      threadIds.push(threadId);
    };

    for (const virtualRow of renderedVirtualRows) {
      if (threadIds.length >= SIDEBAR_MOUNTED_THREAD_PREFETCH_LIMIT) {
        break;
      }
      const item = items[virtualRow.index];
      if (!item) {
        continue;
      }
      if (item.kind === "local") {
        const threadGroup = localProjectThreadGroupById.get(item.projectId);
        if (!threadGroup?.projectExpanded) {
          continue;
        }
        for (const threadId of threadGroup.renderedThreadIds) {
          pushThreadId(threadId);
        }
        continue;
      }
      if (!item.renderedProject.projectExpanded) {
        continue;
      }
      for (const thread of item.renderedProject.visibleThreads) {
        pushThreadId(ThreadId.makeUnsafe(thread.id));
      }
    }

    return threadIds.join("\0");
  })();
  const measureScrollMargin = useEffectEvent(() => {
    const scrollElement = scrollElementRef.current;
    const projectListElement = projectListRef.current;
    if (!scrollElement || !projectListElement) {
      scrollMarginStore.set(0);
      return;
    }
    const nextScrollTop = scrollElement.scrollTop;
    const scrollElementTop = scrollElement.getBoundingClientRect().top;
    const projectListTop = projectListElement.getBoundingClientRect().top;
    const nextScrollMargin = Math.max(0, projectListTop - scrollElementTop + nextScrollTop);
    scrollMarginStore.set(nextScrollMargin);
  });

  const scheduleMeasure = useEffectEvent(() => {
    if (scrollMarginFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMarginFrameRef.current);
    }
    scrollMarginFrameRef.current = window.requestAnimationFrame(() => {
      scrollMarginFrameRef.current = null;
      measureScrollMargin();
    });
  });
  const cancelMeasure = useEffectEvent(() => {
    if (scrollMarginFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(scrollMarginFrameRef.current);
    scrollMarginFrameRef.current = null;
  });

  const setProjectListElement = useStableCallback((element: HTMLUListElement | null) => {
    projectListRef.current = element;
  });

  useLayoutEffect(() => {
    scheduleMeasure();
  }, [layoutMeasureKey]);

  useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current;
    const offsetSourceElement = offsetSourceRef.current;
    const projectListElement = projectListRef.current;
    if (!scrollElement || !projectListElement || typeof ResizeObserver === "undefined") {
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure();
    });
    resizeObserver.observe(scrollElement);
    if (offsetSourceElement) {
      resizeObserver.observe(offsetSourceElement);
    }
    resizeObserver.observe(projectListElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [layoutMeasureKey, offsetSourceRef, scrollElementRef]);

  useEffect(() => {
    return () => {
      cancelMeasure();
    };
  }, []);

  useEffect(() => {
    virtualizer.measure();
  }, [layoutSignature, projectsSectionExpanded, scrollMargin, virtualizer]);

  useEffect(() => {
    const threadIdsToPrefetch = parseSidebarMountedThreadPrefetchKey(mountedThreadPrefetchKey);
    if (threadIdsToPrefetch.length === 0) {
      return;
    }

    let cancelled = false;
    const cancelScheduledPrefetch = scheduleSidebarSpeculativePrefetch(() => {
      void mapWithConcurrencyLimit(
        threadIdsToPrefetch,
        SIDEBAR_THREAD_PREFETCH_CONCURRENCY,
        async (threadId, index) => {
          if (cancelled) {
            return;
          }
          const shouldHydrateStore = index < SIDEBAR_MOUNTED_THREAD_STORE_HYDRATE_COUNT;
          await prefetchThreadHistory(threadId, {
            hydrateStore: shouldHydrateStore,
            prewarmRows: true,
            priority: shouldHydrateStore ? "immediate" : "background",
          });
        },
      );
    });

    return () => {
      cancelled = true;
      cancelScheduledPrefetch();
    };
  }, [mountedThreadPrefetchKey, prefetchThreadHistory]);

  return (
    <SidebarMenu
      ref={setProjectListElement}
      className="relative gap-0"
      style={{ height: `${totalSize}px` }}
    >
      {renderedVirtualRows.map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) {
          return null;
        }
        return renderItem({
          item,
          measureElement: virtualizer.measureElement,
          virtualRow,
          virtualStyle: getVirtualProjectRowStyle(virtualRow, scrollMargin),
        });
      })}
    </SidebarMenu>
  );
}

function createOptimisticProjectCreatedEvent(input: {
  projectId: ProjectId;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  defaultModelSelection: {
    provider: "codex";
    model: string;
  };
}): OrchestrationEvent {
  return {
    type: "project.created",
    sequence: 0,
    eventId: randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: "project",
    aggregateId: input.projectId,
    occurredAt: input.createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: input.defaultModelSelection,
      scripts: [],
      icon: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      archivedAt: null,
    },
  };
}
let remoteSidebarHostSnapshotCache: ReadonlyArray<RemoteSidebarHostEntry> = [];

function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  return (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"]',
    ) !== null
  );
}

type ProjectPickerStep = "environment" | "directory";

type ProjectPickerState = {
  addingProject: boolean;
  projectPickerStep: ProjectPickerStep;
  projectPickerEnvironmentQuery: string;
  projectPickerRemoteHosts: RemoteHostInstance[];
  projectPickerConnectedHostIds: string[];
  projectPickerSelectedConnectionUrl: string | null;
  newCwd: string;
  projectPickerEnvironmentProbeId: string | null;
  isAddingProject: boolean;
};

type ProjectPickerAction =
  | { type: "set-adding-project"; addingProject: boolean }
  | { type: "set-project-picker-step"; projectPickerStep: ProjectPickerStep }
  | { type: "set-project-picker-environment-query"; projectPickerEnvironmentQuery: string }
  | { type: "set-project-picker-remote-hosts"; projectPickerRemoteHosts: RemoteHostInstance[] }
  | { type: "set-project-picker-connected-host-ids"; projectPickerConnectedHostIds: string[] }
  | {
      type: "set-project-picker-selected-connection-url";
      projectPickerSelectedConnectionUrl: string | null;
    }
  | { type: "set-new-cwd"; newCwd: string }
  | {
      type: "set-project-picker-environment-probe-id";
      projectPickerEnvironmentProbeId: string | null;
    }
  | { type: "set-is-adding-project"; isAddingProject: boolean };

function projectPickerStateReducer(
  state: ProjectPickerState,
  action: ProjectPickerAction,
): ProjectPickerState {
  switch (action.type) {
    case "set-adding-project":
      return state.addingProject === action.addingProject
        ? state
        : { ...state, addingProject: action.addingProject };
    case "set-project-picker-step":
      return state.projectPickerStep === action.projectPickerStep
        ? state
        : { ...state, projectPickerStep: action.projectPickerStep };
    case "set-project-picker-environment-query":
      return state.projectPickerEnvironmentQuery === action.projectPickerEnvironmentQuery
        ? state
        : {
            ...state,
            projectPickerEnvironmentQuery: action.projectPickerEnvironmentQuery,
          };
    case "set-project-picker-remote-hosts":
      return state.projectPickerRemoteHosts === action.projectPickerRemoteHosts
        ? state
        : { ...state, projectPickerRemoteHosts: action.projectPickerRemoteHosts };
    case "set-project-picker-connected-host-ids":
      return state.projectPickerConnectedHostIds === action.projectPickerConnectedHostIds
        ? state
        : {
            ...state,
            projectPickerConnectedHostIds: action.projectPickerConnectedHostIds,
          };
    case "set-project-picker-selected-connection-url":
      return state.projectPickerSelectedConnectionUrl === action.projectPickerSelectedConnectionUrl
        ? state
        : {
            ...state,
            projectPickerSelectedConnectionUrl: action.projectPickerSelectedConnectionUrl,
          };
    case "set-new-cwd":
      return state.newCwd === action.newCwd ? state : { ...state, newCwd: action.newCwd };
    case "set-project-picker-environment-probe-id":
      return state.projectPickerEnvironmentProbeId === action.projectPickerEnvironmentProbeId
        ? state
        : {
            ...state,
            projectPickerEnvironmentProbeId: action.projectPickerEnvironmentProbeId,
          };
    case "set-is-adding-project":
      return state.isAddingProject === action.isAddingProject
        ? state
        : { ...state, isAddingProject: action.isAddingProject };
  }
}

interface ProjectPickerEnvironment {
  id: string;
  name: string;
  subtitle: string;
  connectionUrl: string;
  icon: Project["icon"];
  isLocal: boolean;
  isConnected: boolean;
}

function resolveIsoTimestamp(input: string | undefined): number {
  if (!input) {
    return 0;
  }
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function connectionUrlsEqual(left: string, right: string): boolean {
  return normalizeWsUrl(left) === normalizeWsUrl(right);
}

function sortByUpdatedAtDescending<T extends { readonly updatedAt: string }>(
  entries: ReadonlyArray<T>,
): T[] {
  return [...entries].toSorted((left, right) => {
    return resolveIsoTimestamp(right.updatedAt) - resolveIsoTimestamp(left.updatedAt);
  });
}

async function mapWithConcurrencyLimit<TInput, TResult>(
  entries: ReadonlyArray<TInput>,
  concurrency: number,
  mapper: (entry: TInput, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (entries.length === 0) {
    return [];
  }
  const limitedConcurrency = Math.max(1, Math.min(entries.length, Math.floor(concurrency)));
  const results: TResult[] = [];
  results.length = entries.length;
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const entry = entries[index];
    if (entry === undefined) {
      return;
    }
    results[index] = await mapper(entry, index);
    return runWorker();
  };

  const workers = Array.from({ length: limitedConcurrency }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function parseSidebarMountedThreadPrefetchKey(prefetchKey: string): ThreadId[] {
  if (prefetchKey.length === 0) {
    return [];
  }
  return prefetchKey.split("\0").map((threadId) => ThreadId.makeUnsafe(threadId));
}

function scheduleSidebarSpeculativePrefetch(callback: () => void): () => void {
  let cancelled = false;
  const run = () => {
    if (!cancelled) {
      callback();
    }
  };
  const idleWindow = window as Window & {
    readonly requestIdleCallback?: (
      callback: (deadline: IdleDeadline) => void,
      options?: { timeout?: number },
    ) => number;
    readonly cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(run, {
      timeout: SIDEBAR_SPECULATIVE_PREFETCH_IDLE_TIMEOUT_MS,
    });
    return () => {
      cancelled = true;
      idleWindow.cancelIdleCallback?.(handle);
    };
  }

  const timeoutId = window.setTimeout(run, SIDEBAR_SPECULATIVE_PREFETCH_FALLBACK_DELAY_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timeoutId);
  };
}

function remoteProjectKey(connectionUrl: string, projectId: ProjectId): string {
  return `${connectionUrl}::${projectId}`;
}

function modelSelectionEquals(
  left: Project["defaultModelSelection"],
  right: Project["defaultModelSelection"],
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return left.provider === right.provider && left.model === right.model;
}

function remoteThreadEntryEquals(
  left: RemoteSidebarThreadEntry,
  right: RemoteSidebarThreadEntry,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.updatedAt === right.updatedAt &&
    left.lastUserMessageAt === right.lastUserMessageAt
  );
}

function remoteThreadEntriesEqual(
  left: ReadonlyArray<RemoteSidebarThreadEntry>,
  right: ReadonlyArray<RemoteSidebarThreadEntry>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftThread = left[index];
    const rightThread = right[index];
    if (!leftThread || !rightThread || !remoteThreadEntryEquals(leftThread, rightThread)) {
      return false;
    }
  }
  return true;
}

function remoteProjectEntryEquals(
  left: RemoteSidebarProjectEntry,
  right: RemoteSidebarProjectEntry,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.cwd === right.cwd &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastUserMessageAt === right.lastUserMessageAt &&
    projectIconsEqual(left.icon, right.icon) &&
    modelSelectionEquals(left.defaultModelSelection, right.defaultModelSelection) &&
    remoteThreadEntriesEqual(left.threads, right.threads)
  );
}

function remoteProjectEntriesEqual(
  left: ReadonlyArray<RemoteSidebarProjectEntry>,
  right: ReadonlyArray<RemoteSidebarProjectEntry>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftProject = left[index];
    const rightProject = right[index];
    if (!leftProject || !rightProject || !remoteProjectEntryEquals(leftProject, rightProject)) {
      return false;
    }
  }
  return true;
}

function remoteHostEquals(left: RemoteHostInstance, right: RemoteHostInstance): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.wsUrl === right.wsUrl &&
    left.authToken === right.authToken &&
    left.iconGlyph === right.iconGlyph &&
    left.iconColor === right.iconColor &&
    left.lastConnectedAt === right.lastConnectedAt
  );
}

function remoteSidebarHostEntryEquals(
  left: RemoteSidebarHostEntry,
  right: RemoteSidebarHostEntry,
): boolean {
  return (
    left.connectionUrl === right.connectionUrl &&
    left.status === right.status &&
    left.error === right.error &&
    remoteHostEquals(left.host, right.host) &&
    remoteProjectEntriesEqual(left.projects, right.projects)
  );
}

function remoteSidebarHostEntriesEqual(
  left: ReadonlyArray<RemoteSidebarHostEntry>,
  right: ReadonlyArray<RemoteSidebarHostEntry>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftHost = left[index];
    const rightHost = right[index];
    if (!leftHost || !rightHost || !remoteSidebarHostEntryEquals(leftHost, rightHost)) {
      return false;
    }
  }
  return true;
}

function reuseRemoteThreadEntries(
  previousThreads: ReadonlyArray<RemoteSidebarThreadEntry>,
  nextThreads: ReadonlyArray<RemoteSidebarThreadEntry>,
): ReadonlyArray<RemoteSidebarThreadEntry> {
  if (previousThreads === nextThreads || previousThreads.length === 0) {
    return nextThreads;
  }
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  let changed = previousThreads.length !== nextThreads.length;
  const merged = nextThreads.map((thread) => {
    const previousThread = previousById.get(thread.id);
    if (previousThread && remoteThreadEntryEquals(previousThread, thread)) {
      return previousThread;
    }
    changed = true;
    return thread;
  });
  return changed ? merged : previousThreads;
}

function reuseRemoteProjectEntries(
  previousProjects: ReadonlyArray<RemoteSidebarProjectEntry>,
  nextProjects: ReadonlyArray<RemoteSidebarProjectEntry>,
): ReadonlyArray<RemoteSidebarProjectEntry> {
  if (previousProjects === nextProjects || previousProjects.length === 0) {
    return nextProjects;
  }
  const previousById = new Map(previousProjects.map((project) => [project.id, project] as const));
  let changed = previousProjects.length !== nextProjects.length;
  const merged = nextProjects.map((project) => {
    const previousProject = previousById.get(project.id);
    if (!previousProject) {
      changed = true;
      return project;
    }
    const mergedThreads = reuseRemoteThreadEntries(previousProject.threads, project.threads);
    const candidate =
      mergedThreads === project.threads ? project : { ...project, threads: mergedThreads };
    if (remoteProjectEntryEquals(previousProject, candidate)) {
      return previousProject;
    }
    changed = true;
    return candidate;
  });
  return changed ? merged : previousProjects;
}

function getProjectLastUserMessageAt(
  projectId: string,
  threads: OrchestrationShellSnapshot["threads"],
): string {
  let latestTimestamp = "";
  for (const thread of threads) {
    if (thread.projectId !== projectId) continue;
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    if (!latestTimestamp || thread.updatedAt > latestTimestamp) {
      latestTimestamp = thread.updatedAt;
    }
  }
  return latestTimestamp;
}

function sortByLastUserMessage(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function mapRemoteProjectsFromSnapshot(
  snapshot: OrchestrationShellSnapshot,
  sortOrder:
    | "updated_at"
    | "created_at"
    | "last_user_message"
    | "manual"
    | undefined = "last_user_message",
): RemoteSidebarProjectEntry[] {
  const sortFn =
    sortOrder === "created_at"
      ? (a: RemoteSidebarProjectEntry, b: RemoteSidebarProjectEntry) =>
          b.createdAt.localeCompare(a.createdAt)
      : sortOrder === "last_user_message"
        ? (a: RemoteSidebarProjectEntry, b: RemoteSidebarProjectEntry) =>
            sortByLastUserMessage(a.lastUserMessageAt, b.lastUserMessageAt)
        : (a: RemoteSidebarProjectEntry, b: RemoteSidebarProjectEntry) =>
            b.updatedAt.localeCompare(a.updatedAt);

  const sortThreadsFn = (threads: RemoteSidebarThreadEntry[]) =>
    threads.toSorted((a, b) => {
      if (sortOrder === "created_at") {
        return b.updatedAt.localeCompare(a.updatedAt);
      }
      if (sortOrder === "last_user_message") {
        return sortByLastUserMessage(a.lastUserMessageAt, b.lastUserMessageAt);
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  const threadsByProjectId = new Map<string, RemoteSidebarThreadEntry[]>();
  for (const thread of snapshot.threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) {
      continue;
    }
    const projectThreads = threadsByProjectId.get(thread.projectId) ?? [];
    projectThreads.push({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      lastUserMessageAt: thread.updatedAt,
    });
    threadsByProjectId.set(thread.projectId, projectThreads);
  }

  const remoteProjects: RemoteSidebarProjectEntry[] = [];
  for (const project of snapshot.projects) {
    if (project.deletedAt !== null || project.archivedAt !== null) {
      continue;
    }
    const projectThreads = sortThreadsFn(threadsByProjectId.get(project.id) ?? []);
    const lastUserMessageAt =
      getProjectLastUserMessageAt(project.id, snapshot.threads) || project.updatedAt;
    remoteProjects.push({
      id: project.id,
      name: project.title,
      cwd: project.workspaceRoot,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastUserMessageAt,
      icon: project.icon ?? null,
      defaultModelSelection: project.defaultModelSelection,
      threads: projectThreads,
    });
  }
  return remoteProjects.toSorted(sortFn);
}

function projectIconsEqual(left: Project["icon"], right: Project["icon"]): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return left.glyph === right.glyph && left.color === right.color;
}

function resolveRouteConnectionUrlFromSearch(search: string): string | undefined {
  const value = new URLSearchParams(search).get(THREAD_ROUTE_CONNECTION_SEARCH_PARAM)?.trim();
  if (!value) {
    return undefined;
  }
  try {
    return normalizeWsUrl(value);
  } catch {
    return undefined;
  }
}

function getVisibleRemoteThreadsForProject<T extends { id: string }>(input: {
  threads: readonly T[];
  activeThreadId: string | undefined;
  visibleCount: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, threads } = input;
  const visibleCount = Math.max(0, input.visibleCount);
  const hasHiddenThreads = threads.length > visibleCount;
  if (!hasHiddenThreads) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }
  const previewThreads = threads.slice(0, visibleCount);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(visibleCount),
      visibleThreads: previewThreads,
    };
  }
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(visibleCount),
      visibleThreads: previewThreads,
    };
  }
  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));
  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

function prioritizePinnedItems<T>(items: readonly T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const item of items) {
    if (isPinned(item)) {
      pinned.push(item);
    } else {
      unpinned.push(item);
    }
  }
  return pinned.length === 0 ? [...items] : [...pinned, ...unpinned];
}

function sortProjectsByTimestamp(
  projects: readonly Project[],
  projectThreadsByProjectId: ReadonlyMap<ProjectId, readonly SidebarThreadSummary[]>,
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): Project[] {
  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      projectThreadsByProjectId.get(right.id) ?? EMPTY_SIDEBAR_THREADS,
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      projectThreadsByProjectId.get(left.id) ?? EMPTY_SIDEBAR_THREADS,
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

function SidebarHeaderTooltipContent({
  label,
  shortcutLabel,
}: {
  label: string;
  shortcutLabel: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      {shortcutLabel ? (
        <Kbd className="h-4.5 min-w-0 rounded-md bg-background/70 px-1.5 text-[10px] text-foreground/75 dark:bg-background/25">
          {shortcutLabel}
        </Kbd>
      ) : null}
    </span>
  );
}

type SidebarLocalProjectItemProps = Omit<
  ComponentProps<typeof SidebarLocalProjectSection>,
  "projectId" | "dragHandleProps"
> & {
  dragHandleProps: SortableProjectHandleProps | null;
  projectId: ProjectId;
};

function SidebarLocalProjectItem({
  dragHandleProps,
  projectId,
  ...props
}: SidebarLocalProjectItemProps) {
  return (
    <SidebarLocalProjectSection
      projectId={projectId}
      dragHandleProps={dragHandleProps}
      {...props}
    />
  );
}

type SidebarRemoteProjectItemRowProps = Omit<
  ComponentProps<typeof SidebarThreadRow>,
  | "threadId"
  | "orderedProjectThreadIds"
  | "routeThreadId"
  | "activeRouteConnectionUrl"
  | "connectionUrl"
  | "showThreadJumpHints"
  | "jumpLabel"
  | "boardDrag"
  | "pr"
  | "handleThreadContextMenu"
  | "navigateToThread"
>;

type SidebarRemoteProjectItemProps = {
  readonly activeRouteConnectionUrl: string;
  readonly createBoardThreadRowDragProps: (thread: {
    connectionUrl: string;
    threadId: ThreadId;
  }) => NonNullable<ComponentProps<typeof SidebarThreadRow>["boardDrag"]>;
  readonly expandThreadListForRemoteProject: (projectKey: string) => void;
  readonly collapseThreadListForRemoteProject: (projectKey: string) => void;
  readonly getThreadPr: (threadId: ThreadId) => ComponentProps<typeof SidebarThreadRow>["pr"];
  readonly handleRemoteProjectContextMenu: (
    input: { connectionUrl: string; project: RemoteSidebarProjectEntry },
    position: { x: number; y: number },
  ) => Promise<void>;
  readonly handleRemoteThreadContextMenu: (
    input: {
      connectionUrl: string;
      project: RemoteSidebarProjectEntry;
      thread: RemoteSidebarThreadEntry;
    },
    position: { x: number; y: number },
  ) => Promise<void>;
  readonly handleStartNewThreadForRemoteProject: (input: {
    connectionUrl: string;
    project: RemoteSidebarProjectEntry;
  }) => void;
  readonly navigateToThreadOnConnection: (connectionUrl: string, threadId: ThreadId) => void;
  readonly newThreadShortcutLabel: string | null;
  readonly renderedProject: RenderedRemoteSidebarProject;
  readonly routeThreadId: ThreadId | null;
  readonly showThreadJumpHints: boolean;
  readonly threadRowSharedProps: SidebarRemoteProjectItemRowProps;
  readonly toggleRemoteProject: (projectKey: string) => void;
};

function SidebarRemoteProjectItem({
  activeRouteConnectionUrl,
  createBoardThreadRowDragProps,
  expandThreadListForRemoteProject,
  collapseThreadListForRemoteProject,
  getThreadPr,
  handleRemoteProjectContextMenu,
  handleRemoteThreadContextMenu,
  handleStartNewThreadForRemoteProject,
  navigateToThreadOnConnection,
  newThreadShortcutLabel,
  renderedProject,
  routeThreadId,
  showThreadJumpHints,
  threadRowSharedProps,
  toggleRemoteProject,
}: SidebarRemoteProjectItemProps) {
  const {
    project,
    projectKey,
    connectionUrl,
    projectExpanded,
    visibleThreads,
    hiddenThreadCount,
    hasHiddenThreads,
    canCollapseThreadList,
  } = renderedProject;

  const sortedThreadIds = sortByUpdatedAtDescending(project.threads).map((thread) =>
    ThreadId.makeUnsafe(thread.id),
  );
  const shouldRenderThreadPanel = projectExpanded;
  const { prefetchThreadHistory } = threadRowSharedProps;

  useEffect(() => {
    if (!projectExpanded || visibleThreads.length === 0) {
      return;
    }
    return scheduleSidebarSpeculativePrefetch(() => {
      const hostStore = useHostConnectionStore.getState();
      for (const thread of visibleThreads) {
        const threadId = ThreadId.makeUnsafe(thread.id);
        hostStore.upsertThreadOwnership(connectionUrl, threadId);
        void prefetchThreadHistory(threadId, {
          hydrateStore: false,
          prewarmRows: true,
          priority: "background",
        });
      }
    });
  }, [connectionUrl, prefetchThreadHistory, projectExpanded, visibleThreads]);

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          size="sm"
          className="cursor-pointer gap-2 px-2 py-1.5 text-left text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-pill-foreground group-hover/project-header:bg-foreground/[0.06] group-hover/project-header:text-pill-foreground"
          onClick={() => toggleRemoteProject(projectKey)}
          onContextMenu={(event) => {
            event.preventDefault();
            void handleRemoteProjectContextMenu(
              {
                connectionUrl,
                project,
              },
              {
                x: event.clientX,
                y: event.clientY,
              },
            );
          }}
        >
          <ChevronRightIcon
            className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
              projectExpanded ? "rotate-90" : ""
            }`}
          />
          <ProjectAvatar project={{ cwd: project.cwd, icon: project.icon }} />
          <span className="flex-1 truncate text-xs font-medium">{project.name}</span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="top-1 right-1.5 size-5 rounded-md bg-transparent p-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleStartNewThreadForRemoteProject({
                    connectionUrl,
                    project,
                  });
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      {shouldRenderThreadPanel && (
        <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0">
          {projectExpanded && visibleThreads.length === 0 ? (
            <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
              <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                <span>No threads yet</span>
              </div>
            </SidebarMenuSubItem>
          ) : null}
          {projectExpanded &&
            visibleThreads.map((thread) => {
              const threadId = ThreadId.makeUnsafe(thread.id);
              const boardDrag = createBoardThreadRowDragProps({
                connectionUrl,
                threadId,
              });
              return (
                <SidebarThreadRow
                  key={thread.id}
                  threadId={threadId}
                  orderedProjectThreadIds={sortedThreadIds}
                  routeThreadId={routeThreadId}
                  activeRouteConnectionUrl={activeRouteConnectionUrl}
                  connectionUrl={connectionUrl}
                  showThreadJumpHints={showThreadJumpHints}
                  jumpLabel={null}
                  pr={getThreadPr(threadId)}
                  boardDrag={boardDrag}
                  {...threadRowSharedProps}
                  handleThreadContextMenu={async (id, position) => {
                    const remoteThread = project.threads.find((entry) => entry.id === id);
                    if (!remoteThread) {
                      return;
                    }
                    await handleRemoteThreadContextMenu(
                      {
                        connectionUrl,
                        project,
                        thread: remoteThread,
                      },
                      position,
                    );
                  }}
                  navigateToThread={() => {
                    navigateToThreadOnConnection(connectionUrl, threadId);
                  }}
                />
              );
            })}

          {projectExpanded && hasHiddenThreads ? (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" aria-label="Show more remote project threads" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 dark:hover:text-foreground dark:hover:brightness-125"
                onClick={() => {
                  expandThreadListForRemoteProject(projectKey);
                }}
              >
                <span>Show {Math.min(THREAD_REVEAL_STEP, hiddenThreadCount)} more</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          {projectExpanded && canCollapseThreadList ? (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" aria-label="Show fewer remote project threads" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start bg-transparent px-2 text-left text-[10px] font-medium text-muted-foreground/60 transition-[filter,opacity,color] duration-150 hover:bg-transparent hover:text-foreground/90 hover:opacity-100 hover:brightness-90 dark:hover:text-foreground dark:hover:brightness-125"
                onClick={() => {
                  collapseThreadListForRemoteProject(projectKey);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      )}
    </>
  );
}

SidebarRemoteProjectItem.displayName = "SidebarRemoteProjectItem";

function useSidebarComponent() {
  const { isMobile, state: sidebarState } = useSidebar();
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const readSidebarThreadSummary = useStableCallback(
    (threadId: ThreadId) => useStore.getState().sidebarThreadsById[threadId],
  );
  const savedSplitBoard = useChatThreadBoardStore(
    useShallow((store) => ({
      activePaneId: store.activePaneId,
      activeSplitId: store.activeSplitId,
      layoutRoot: store.layoutRoot,
      panes: store.panes,
      splits: store.splits,
    })),
  );
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const {
    boardsSectionExpanded,
    pinnedItems,
    pinnedSectionExpanded,
    projectExpandedById,
    projectOrder,
    projectsSectionExpanded,
  } = useUiStateStore(
    useShallow((store) => ({
      boardsSectionExpanded: store.boardsSectionExpanded,
      pinnedItems: store.pinnedItems,
      pinnedSectionExpanded: store.pinnedSectionExpanded,
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      projectsSectionExpanded: store.projectsSectionExpanded,
    })),
  );
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const togglePinnedProject = useUiStateStore((store) => store.togglePinnedProject);
  const togglePinnedThread = useUiStateStore((store) => store.togglePinnedThread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const setPinnedSectionExpanded = useUiStateStore((store) => store.setPinnedSectionExpanded);
  const setProjectsSectionExpanded = useUiStateStore((store) => store.setProjectsSectionExpanded);
  const setBoardsSectionExpanded = useUiStateStore((store) => store.setBoardsSectionExpanded);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const locationSearch = useLocation({ select: (loc) => loc.searchStr });
  const isOnSettings = pathname.startsWith("/settings");
  const configuredAddProjectBaseDirectory = useSetting("addProjectBaseDirectory");
  const confirmThreadArchive = useSetting("confirmThreadArchive");
  const confirmThreadDelete = useSetting("confirmThreadDelete");
  const defaultThreadEnvMode = useSetting("defaultThreadEnvMode");
  const sidebarProjectSortOrder = useSetting("sidebarProjectSortOrder");
  const sidebarThreadSortOrder = useSetting("sidebarThreadSortOrder");
  const { updateSettings } = useUpdateSettings();
  const pinnedProjectIds = pinnedItems.flatMap((item) =>
    item.kind === "project" ? [item.id] : [],
  );
  const pinnedThreadIds = pinnedItems.flatMap((item) => (item.kind === "thread" ? [item.id] : []));
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const { archiveThread, deleteThread, deleteWorktreeAndRelatedThreads } = useThreadActions();
  const keybindings = useServerKeybindings();
  const [projectPickerState, dispatchProjectPickerState] = useReducer(projectPickerStateReducer, {
    addingProject: false,
    projectPickerStep: "environment",
    projectPickerEnvironmentQuery: "",
    projectPickerRemoteHosts: [],
    projectPickerConnectedHostIds: [],
    projectPickerSelectedConnectionUrl: null,
    newCwd: "",
    projectPickerEnvironmentProbeId: null,
    isAddingProject: false,
  });
  const {
    addingProject,
    projectPickerStep,
    projectPickerEnvironmentQuery,
    projectPickerRemoteHosts,
    projectPickerConnectedHostIds,
    projectPickerSelectedConnectionUrl,
    newCwd,
    projectPickerEnvironmentProbeId,
    isAddingProject,
  } = projectPickerState;
  const [projectPickerBrowseUiState, dispatchProjectPickerBrowseUiState] = useReducer(
    projectPickerBrowseUiStateReducer,
    EMPTY_PROJECT_PICKER_BROWSE_UI_STATE,
  );
  const {
    addProjectError,
    activeProjectBrowseIndex,
    projectBrowseState,
    projectPickerKeyboardNavigationId,
  } = projectPickerBrowseUiState;
  const lastKeyboardNavigationTimeRef = useRef(0);
  const threadHistoryPrefetchByThreadIdRef = useRef<
    Map<ThreadId, Promise<OrchestrationReadModel["threads"][number]>>
  >(null!);
  if (threadHistoryPrefetchByThreadIdRef.current === null) {
    threadHistoryPrefetchByThreadIdRef.current = new Map<
      ThreadId,
      Promise<OrchestrationReadModel["threads"][number]>
    >();
  }
  const providerStatuses = useServerProviders({
    enabled: addingProject || isAddingProject,
  });
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const projectPickerListRef = useRef<HTMLDivElement | null>(null);
  const setProjectBrowseState = (
    nextState: ProjectBrowseState | ((current: ProjectBrowseState) => ProjectBrowseState),
  ) => {
    dispatchProjectPickerBrowseUiState({ type: "set-project-browse-state", nextState });
  };
  const setActiveProjectBrowseIndex = (nextIndex: number | ((current: number) => number)) => {
    dispatchProjectPickerBrowseUiState({ type: "set-active-project-browse-index", nextIndex });
  };
  const setAddProjectError = (error: string | null) => {
    dispatchProjectPickerBrowseUiState({ type: "set-add-project-error", error });
  };
  const requestProjectPickerKeyboardScroll = (eventTimeStamp: number) => {
    lastKeyboardNavigationTimeRef.current = eventTimeStamp;
    dispatchProjectPickerBrowseUiState({ type: "bump-keyboard-navigation-id" });
  };
  const searchPaletteListRef = useRef<HTMLDivElement | null>(null);
  const sidebarContentScrollRef = useRef<HTMLDivElement | null>(null);
  const sidebarProjectListOffsetSourceRef = useRef<HTMLDivElement | null>(null);
  const browseRequestVersionRef = useRef(0);
  const [sidebarEditorState, dispatchSidebarEditorState] = useReducer(
    sidebarEditorStateReducer,
    EMPTY_SIDEBAR_EDITOR_STATE,
  );
  const {
    renamingThreadId,
    renamingTitle,
    projectEditorOpen,
    editingProjectId,
    editingProjectConnectionUrl,
    editingProjectName,
    editingProjectIcon,
    remoteThreadRenameTarget,
    remoteThreadRenameTitle,
  } = sidebarEditorState;
  const setRenamingTitle = (renamingTitle: string) => {
    dispatchSidebarEditorState({ type: "set-renaming-title", renamingTitle });
  };
  const setEditingProjectName = (editingProjectName: string) => {
    dispatchSidebarEditorState({ type: "set-editing-project-name", editingProjectName });
  };
  const setEditingProjectIcon = (
    nextIcon: Project["icon"] | ((current: Project["icon"]) => Project["icon"]),
  ) => {
    dispatchSidebarEditorState({ type: "set-editing-project-icon", nextIcon });
  };
  const [sidebarAuxUiState, dispatchSidebarAuxUiState] = useReducer(
    sidebarAuxUiStateReducer,
    EMPTY_SIDEBAR_AUX_UI_STATE,
  );
  const [sidebarSplitBoardUiState, dispatchSidebarSplitBoardUiState] = useReducer(
    sidebarSplitBoardUiStateReducer,
    EMPTY_SIDEBAR_SPLIT_BOARD_UI_STATE,
  );
  const {
    splitSortOrder,
    splitRevealCount,
    splitPickerOpen,
    splitPickerQuery,
    splitPickerProjectFilter,
    splitPickerSortOrder,
    splitPickerSelectedThreadIds,
    splitContextMenuState,
    renamingSplitId,
    renamingSplitTitle,
    boardThreadDragState,
  } = sidebarSplitBoardUiState;
  const setSplitSortOrder = (splitSortOrder: SidebarSplitSortOrder) => {
    dispatchSidebarSplitBoardUiState({ type: "set-split-sort-order", splitSortOrder });
  };
  const setSplitRevealCount = (nextCount: number | ((current: number) => number)) => {
    dispatchSidebarSplitBoardUiState({ type: "set-split-reveal-count", nextCount });
  };
  const setSplitPickerQuery = (splitPickerQuery: string) => {
    dispatchSidebarSplitBoardUiState({ type: "set-split-picker-query", splitPickerQuery });
  };
  const setSplitPickerProjectFilter = (splitPickerProjectFilter: string) => {
    dispatchSidebarSplitBoardUiState({
      type: "set-split-picker-project-filter",
      splitPickerProjectFilter,
    });
  };
  const setSplitPickerSortOrder = (splitPickerSortOrder: SplitPickerSortOrder) => {
    dispatchSidebarSplitBoardUiState({ type: "set-split-picker-sort-order", splitPickerSortOrder });
  };
  const setRenamingSplitTitle = (renamingSplitTitle: string) => {
    dispatchSidebarSplitBoardUiState({ type: "set-renaming-split-title", renamingSplitTitle });
  };
  const {
    confirmingArchiveThreadId,
    threadRevealCountByProject,
    desktopUpdateState,
    remoteSidebarHosts,
    remoteProjectExpandedById,
    remoteThreadRevealCountByProject,
  } = sidebarAuxUiState;
  const setConfirmingArchiveThreadId = (
    confirmingArchiveThreadId: ThreadId | null | ((current: ThreadId | null) => ThreadId | null),
  ) => {
    dispatchSidebarAuxUiState({
      type: "set-confirming-archive-thread-id",
      confirmingArchiveThreadId,
    });
  };
  const setThreadRevealCountByProject = useStableCallback(
    (
      threadRevealCountByProject:
        | Partial<Record<ProjectId, number>>
        | ((current: Partial<Record<ProjectId, number>>) => Partial<Record<ProjectId, number>>),
    ) => {
      dispatchSidebarAuxUiState({
        type: "set-thread-reveal-count-by-project",
        threadRevealCountByProject,
      });
    },
  );
  const setDesktopUpdateState = (
    desktopUpdateState:
      | DesktopUpdateState
      | null
      | ((current: DesktopUpdateState | null) => DesktopUpdateState | null),
  ) => {
    dispatchSidebarAuxUiState({
      type: "set-desktop-update-state",
      desktopUpdateState,
    });
  };
  const setRemoteSidebarHosts = useStableCallback(
    (
      remoteSidebarHosts:
        | ReadonlyArray<RemoteSidebarHostEntry>
        | ((
            current: ReadonlyArray<RemoteSidebarHostEntry>,
          ) => ReadonlyArray<RemoteSidebarHostEntry>),
    ) => {
      dispatchSidebarAuxUiState({
        type: "set-remote-sidebar-hosts",
        remoteSidebarHosts,
      });
    },
  );
  const setRemoteProjectExpandedById = (
    remoteProjectExpandedById:
      | Record<string, boolean>
      | ((current: Record<string, boolean>) => Record<string, boolean>),
  ) => {
    dispatchSidebarAuxUiState({
      type: "set-remote-project-expanded-by-id",
      remoteProjectExpandedById,
    });
  };
  const setRemoteThreadRevealCountByProject = useStableCallback(
    (
      remoteThreadRevealCountByProject:
        | Record<string, number>
        | ((current: Record<string, number>) => Record<string, number>),
    ) => {
      dispatchSidebarAuxUiState({
        type: "set-remote-thread-reveal-count-by-project",
        remoteThreadRevealCountByProject,
      });
    },
  );
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef<Map<ThreadId, HTMLButtonElement>>(null!);
  if (confirmArchiveButtonRefs.current === null) {
    confirmArchiveButtonRefs.current = new Map<ThreadId, HTMLButtonElement>();
  }
  const sidebarHeaderRowRef = useRef<HTMLDivElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const showSidebarHeaderToggle = !isMobile && sidebarState === "expanded";
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const localDeviceHost = splitWsUrlAuthToken(resolveLocalDeviceWsUrl());
  const localDeviceConnectionUrl = resolveHostConnectionWsUrl(localDeviceHost);
  const activeWsUrl = localDeviceConnectionUrl;
  const routeThreadConnectionUrl = useHostConnectionStore((store) =>
    routeThreadId ? store.threadConnectionById[routeThreadId] : undefined,
  );
  const activeRouteConnectionUrl = (() => {
    const routeConnection = resolveRouteConnectionUrlFromSearch(locationSearch);
    if (routeConnection) {
      return routeConnection;
    }
    if (routeThreadConnectionUrl) {
      try {
        return normalizeWsUrl(routeThreadConnectionUrl);
      } catch {
        // Keep UI navigable even if a stale URL was persisted.
      }
    }
    return localDeviceConnectionUrl;
  })();
  const activeStoreSplitId =
    savedSplitBoard.activeSplitId && savedSplitBoard.panes.length > 1
      ? savedSplitBoard.activeSplitId
      : null;
  const savedBoards = (() => {
    const activeBoards = savedSplitBoard.splits.filter((split) => split.archivedAt === null);
    return activeBoards.toSorted((left, right) => {
      const updatedSort =
        resolveIsoTimestamp(right.updatedAt) - resolveIsoTimestamp(left.updatedAt);
      if (splitSortOrder === "created_at") {
        return resolveIsoTimestamp(right.createdAt) - resolveIsoTimestamp(left.createdAt);
      }
      if (splitSortOrder === "name") {
        return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      }
      if (splitSortOrder === "pane_count") {
        return right.panes.length - left.panes.length || updatedSort;
      }
      return updatedSort;
    });
  })();
  const visibleSavedBoards = savedBoards.slice(0, splitRevealCount);
  const hiddenSavedSplitCount = Math.max(0, savedBoards.length - visibleSavedBoards.length);
  const canCollapseSplitList = splitRevealCount > SPLIT_REVEAL_STEP;
  const contextMenuSplit = splitContextMenuState
    ? (savedBoards.find((split) => split.id === splitContextMenuState.splitId) ?? null)
    : null;
  useEffect(() => {
    dispatchSidebarSplitBoardUiState({
      type: "set-split-reveal-count",
      nextCount: SPLIT_REVEAL_STEP,
    });
  }, [splitSortOrder]);
  const buildSplitTitle = (threads: ReadonlyArray<{ threadId: ThreadId }>) => {
    return buildThreadBoardTitle({
      fallbackIndex: savedSplitBoard.splits.length + 1,
      threads: threads.map((thread) => ({
        threadId: thread.threadId,
        title: sidebarThreadsById[thread.threadId]?.title,
      })),
    });
  };
  const clearBoardThreadDrag = () => {
    setActiveThreadBoardDrag(null);
    dispatchSidebarSplitBoardUiState({
      type: "set-board-thread-drag-state",
      boardThreadDragState: null,
    });
  };
  const setBoardThreadDragOverTarget = (targetKey: string | null) => {
    dispatchSidebarSplitBoardUiState({
      type: "set-board-thread-drag-over-target",
      overTargetKey: targetKey,
    });
  };
  const readBoardThreadDrag = (event?: DragEvent<HTMLElement>): ThreadBoardDragThread | null => {
    if (boardThreadDragState?.activeThread) {
      return boardThreadDragState.activeThread;
    }
    const encodedThread =
      event?.dataTransfer?.getData(THREAD_BOARD_DRAG_MIME) ||
      event?.dataTransfer?.getData("text/plain");
    if (encodedThread) {
      return decodeThreadBoardDragThread(encodedThread);
    }
    return null;
  };
  const restoreSavedSplit = (
    split: ChatThreadBoardSplitState,
    targetPane?: ChatThreadBoardPaneState | null,
  ) => {
    const orderedPanes = orderBoardPanes(split.panes, split.layoutRoot);
    const activePane =
      targetPane ??
      orderedPanes.find((pane) => pane.id === split.activePaneId) ??
      orderedPanes[0] ??
      null;
    if (!activePane || orderedPanes.length <= 1) {
      return;
    }

    for (const pane of orderedPanes) {
      if (pane.connectionUrl) {
        useHostConnectionStore.getState().upsertThreadOwnership(pane.connectionUrl, pane.threadId);
      }
    }
    if (activeStoreSplitId !== split.id || savedSplitBoard.activePaneId !== activePane.id) {
      useChatThreadBoardStore.getState().restoreSplit(split.id, activePane.id);
    }
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: activePane.threadId },
        search: buildSingleThreadRouteSearch({ connectionUrl: activePane.connectionUrl }),
      });
    });
  };
  const navigateToBoardThreadRoute = (activePane: {
    connectionUrl: string | null;
    threadId: ThreadId;
  }) => {
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: activePane.threadId },
        search: buildSingleThreadRouteSearch({ connectionUrl: activePane.connectionUrl }),
      });
    });
  };
  const buildBoardFromDraggedThreads = (
    threads: ReadonlyArray<{
      connectionUrl: string | null;
      threadId: ThreadId;
      title?: string | null | undefined;
    }>,
    activeThread: {
      connectionUrl: string | null;
      threadId: ThreadId;
      title?: string | null | undefined;
    },
  ) => {
    const uniqueThreads = [
      ...new Map(threads.map((thread) => [getThreadBoardDragThreadKey(thread), thread])).values(),
    ];
    if (uniqueThreads.length < 2) {
      return;
    }
    for (const thread of uniqueThreads) {
      if (thread.connectionUrl) {
        useHostConnectionStore
          .getState()
          .upsertThreadOwnership(thread.connectionUrl, thread.threadId);
      }
    }
    const splitId = useChatThreadBoardStore.getState().createSplit({
      activeThread,
      threads: uniqueThreads,
      title: buildSplitTitle(uniqueThreads),
    });
    if (!splitId) {
      return;
    }
    navigateToBoardThreadRoute(activeThread);
  };
  const handleBoardThreadDragStart = (
    thread: { connectionUrl: string | null; threadId: ThreadId },
    event: DragEvent<HTMLAnchorElement>,
  ) => {
    const dragThread = createThreadBoardDragThread({
      ...thread,
      title: sidebarThreadsById[thread.threadId]?.title ?? null,
    });
    const payload = encodeThreadBoardDragThread(dragThread);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(THREAD_BOARD_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", payload);
    setThreadBoardDragImage(event.dataTransfer, {
      label: event.currentTarget.textContent,
      tone: "copy",
    });
    setActiveThreadBoardDrag(dragThread);
    setBoardsSectionExpanded(true);
    dispatchSidebarSplitBoardUiState({
      type: "set-board-thread-drag-state",
      boardThreadDragState: {
        activeThread: dragThread,
        activeThreadKey: getThreadBoardDragThreadKey(dragThread),
        overTargetKey: null,
      },
    });
  };
  const handleBoardThreadDropOnThread = (
    target: {
      connectionUrl: string | null;
      threadId: ThreadId;
      title?: string | null | undefined;
    },
    event: DragEvent<HTMLLIElement>,
  ) => {
    event.preventDefault();
    const source = readBoardThreadDrag(event);
    clearBoardThreadDrag();
    if (!source) {
      return;
    }
    const sourceKey = getThreadBoardDragThreadKey(source);
    const targetKey = getThreadBoardDragThreadKey(target);
    if (sourceKey === targetKey) {
      return;
    }
    const targetWithTitle = {
      ...target,
      title: target.title ?? sidebarThreadsById[target.threadId]?.title ?? null,
    };
    buildBoardFromDraggedThreads([source, targetWithTitle], targetWithTitle);
  };
  const handleBoardThreadDropOnSavedBoard = (
    split: ChatThreadBoardSplitState,
    event: DragEvent<HTMLLIElement>,
  ) => {
    event.preventDefault();
    const source = readBoardThreadDrag(event);
    clearBoardThreadDrag();
    if (!source) {
      return;
    }
    if (source.connectionUrl) {
      useHostConnectionStore
        .getState()
        .upsertThreadOwnership(source.connectionUrl, source.threadId);
    }
    const openedPaneId = useChatThreadBoardStore.getState().openThreadInSplit(split.id, source);
    const nextSplit = useChatThreadBoardStore
      .getState()
      .splits.find((candidate) => candidate.id === split.id);
    if (!nextSplit) {
      return;
    }
    const targetPane =
      nextSplit.panes.find((pane) => pane.id === openedPaneId) ??
      nextSplit.panes.find(
        (pane) => getThreadBoardDragThreadKey(pane) === getThreadBoardDragThreadKey(source),
      ) ??
      null;
    restoreSavedSplit(nextSplit, targetPane);
  };
  const createBoardThreadRowDragProps = (thread: {
    connectionUrl: string | null;
    threadId: ThreadId;
  }) => {
    const targetKey = getThreadBoardDragThreadKey(thread);
    const isDragging = boardThreadDragState?.activeThreadKey === targetKey;
    const isDropTarget =
      boardThreadDragState !== null &&
      boardThreadDragState.overTargetKey === targetKey &&
      boardThreadDragState.activeThreadKey !== targetKey;
    return {
      isDragging,
      isDropTarget,
      onDragEnd: clearBoardThreadDrag,
      onDragLeave: (event: DragEvent<HTMLLIElement>) => {
        const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
          return;
        }
        if (boardThreadDragState?.overTargetKey === targetKey) {
          setBoardThreadDragOverTarget(null);
        }
      },
      onDragOver: (event: DragEvent<HTMLLIElement>) => {
        const source = readBoardThreadDrag(event);
        if (!source) {
          return;
        }
        if (getThreadBoardDragThreadKey(source) === targetKey) {
          setBoardThreadDragOverTarget(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setBoardThreadDragOverTarget(targetKey);
      },
      onDragStart: (event: DragEvent<HTMLAnchorElement>) => {
        handleBoardThreadDragStart(thread, event);
      },
      onDrop: (event: DragEvent<HTMLLIElement>) => {
        handleBoardThreadDropOnThread(thread, event);
      },
    };
  };
  const handleSavedBoardDragLeave = (splitId: string, event: DragEvent<HTMLLIElement>) => {
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    if (boardThreadDragState?.overTargetKey === splitId) {
      setBoardThreadDragOverTarget(null);
    }
  };
  const handleSavedBoardDragOver = (
    split: ChatThreadBoardSplitState,
    event: DragEvent<HTMLLIElement>,
  ) => {
    const source = readBoardThreadDrag(event);
    if (!source) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = split.panes.some(
      (pane) => getThreadBoardDragThreadKey(pane) === getThreadBoardDragThreadKey(source),
    )
      ? "move"
      : "copy";
    setBoardThreadDragOverTarget(split.id);
  };
  const openThreadInSplit = (target: {
    connectionUrl: string | null;
    threadId: ThreadId;
    title?: string | null | undefined;
  }) => {
    if (target.connectionUrl) {
      useHostConnectionStore
        .getState()
        .upsertThreadOwnership(target.connectionUrl, target.threadId);
    }

    const shouldUpdateActiveSplit = activeStoreSplitId !== null;

    if (shouldUpdateActiveSplit) {
      useChatThreadBoardStore.getState().openThreadInBoard({
        connectionUrl: target.connectionUrl,
        direction: "right",
        paneTitle: target.title ?? null,
        sourcePaneId: savedSplitBoard.activePaneId,
        threadId: target.threadId,
      });
      navigateToBoardThreadRoute(target);
      return;
    }

    const threads = routeThreadId
      ? [
          {
            connectionUrl: resolveConnectionForThreadId(routeThreadId) ?? null,
            threadId: routeThreadId,
            title: sidebarThreadsById[routeThreadId]?.title ?? null,
          },
          target,
        ]
      : [target];
    const splitId = useChatThreadBoardStore.getState().createSplit({
      activeThread: target,
      threads,
      title: buildSplitTitle(threads),
    });
    if (!splitId) {
      return;
    }
    navigateToBoardThreadRoute(target);
  };
  const openThreadsInSplit = (
    targets: ReadonlyArray<{
      connectionUrl: string | null;
      threadId: ThreadId;
      title?: string | null | undefined;
    }>,
  ) => {
    if (targets.length === 0) {
      return;
    }
    for (const target of targets) {
      if (target.connectionUrl) {
        useHostConnectionStore
          .getState()
          .upsertThreadOwnership(target.connectionUrl, target.threadId);
      }
    }
    const activeTarget = targets[targets.length - 1]!;
    const shouldUpdateActiveSplit = activeStoreSplitId !== null;

    if (shouldUpdateActiveSplit) {
      useChatThreadBoardStore
        .getState()
        .openThreadsInBoard(targets, { sourcePaneId: savedSplitBoard.activePaneId });
      navigateToBoardThreadRoute(activeTarget);
      return;
    }

    const threads =
      routeThreadId === null
        ? targets
        : [
            {
              connectionUrl: resolveConnectionForThreadId(routeThreadId) ?? null,
              threadId: routeThreadId,
              title: sidebarThreadsById[routeThreadId]?.title ?? null,
            },
            ...targets,
          ];
    const splitId = useChatThreadBoardStore.getState().createSplit({
      activeThread: activeTarget,
      threads,
      title: buildSplitTitle(threads),
    });
    if (!splitId) {
      return;
    }
    navigateToBoardThreadRoute(activeTarget);
  };
  const closeActiveSplitRoute = () => {
    if (!routeThreadId) {
      return;
    }
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: routeThreadId },
        search: buildSingleThreadRouteSearch({
          connectionUrl: resolveConnectionForThreadId(routeThreadId) ?? null,
        }),
      });
    });
  };
  const cancelSplitRename = () => {
    dispatchSidebarSplitBoardUiState({ type: "cancel-split-rename" });
  };
  const commitSplitRename = (split: ChatThreadBoardSplitState) => {
    const title = renamingSplitTitle.trim();
    if (!title) {
      toastManager.add({
        type: "warning",
        title: "Split name cannot be empty",
      });
      cancelSplitRename();
      return;
    }
    useChatThreadBoardStore.getState().renameSplit(split.id, title);
    cancelSplitRename();
  };
  const closeSplitContextMenu = () => {
    dispatchSidebarSplitBoardUiState({
      type: "set-split-context-menu-state",
      splitContextMenuState: null,
    });
  };
  const openSplitContextMenu = (
    split: ChatThreadBoardSplitState,
    position: { x: number; y: number },
  ) => {
    dispatchSidebarSplitBoardUiState({
      type: "set-split-context-menu-state",
      splitContextMenuState: { position, splitId: split.id },
    });
  };
  const handleSplitMenuAction = async (
    split: ChatThreadBoardSplitState,
    action: "archive" | "delete" | "open" | "rename",
  ) => {
    closeSplitContextMenu();
    if (action === "open") {
      restoreSavedSplit(split);
      return;
    }
    if (action === "rename") {
      dispatchSidebarSplitBoardUiState({
        type: "start-split-rename",
        renamingSplitId: split.id,
        renamingSplitTitle: split.title,
      });
      return;
    }
    if (action === "archive") {
      useChatThreadBoardStore.getState().archiveSplit(split.id);
      if (activeStoreSplitId === split.id) {
        closeActiveSplitRoute();
      }
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [`Delete split "${split.title}"?`, "The threads are not deleted."].join("\n"),
    );
    if (!confirmed) {
      return;
    }
    useChatThreadBoardStore.getState().deleteSplit(split.id);
    if (activeStoreSplitId === split.id) {
      closeActiveSplitRoute();
    }
  };
  const remoteSidebarHostsRef = useRef<ReadonlyArray<RemoteSidebarHostEntry>>(
    remoteSidebarHostSnapshotCache,
  );
  const registeredRemoteRouteConnectionUrlsRef = useRef<Set<string>>(null!);
  if (registeredRemoteRouteConnectionUrlsRef.current === null) {
    registeredRemoteRouteConnectionUrlsRef.current = new Set<string>();
  }
  const remoteSnapshotSequenceByConnectionRef = useRef<Map<string, number>>(null!);
  if (remoteSnapshotSequenceByConnectionRef.current === null) {
    remoteSnapshotSequenceByConnectionRef.current = new Map<string, number>();
  }
  const pendingRemoteSnapshotMergeByConnectionRef = useRef<Map<string, OrchestrationShellSnapshot>>(
    null!,
  );
  if (pendingRemoteSnapshotMergeByConnectionRef.current === null) {
    pendingRemoteSnapshotMergeByConnectionRef.current = new Map<
      string,
      OrchestrationShellSnapshot
    >();
  }
  const remoteSnapshotMergeScheduledRef = useRef(false);
  const remoteSnapshotMergeHandleRef = useRef<{ kind: "idle" | "timeout"; id: number } | null>(
    null,
  );
  const remoteSidebarRefreshVersionRef = useRef(0);
  const remoteSidebarRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const projectConnectionById = useHostConnectionStore((store) => store.projectConnectionById);
  useEffect(() => {
    remoteSidebarHostsRef.current = remoteSidebarHosts;
    remoteSidebarHostSnapshotCache = remoteSidebarHosts;
  }, [remoteSidebarHosts]);
  const shouldShowProjectPathEntry = addingProject;
  const normalizedProjectSearchQuery = "";
  const activeProjects = projects.filter((project) => {
    if (project.archivedAt !== null) {
      return false;
    }
    const ownerConnectionUrl = projectConnectionById[project.id];
    return (
      ownerConnectionUrl === undefined ||
      connectionUrlsEqual(ownerConnectionUrl, localDeviceConnectionUrl)
    );
  });
  const orderedProjects = orderItemsByPreferredIds({
    items: activeProjects,
    preferredIds: projectOrder,
    getId: (project) => project.id,
  });
  const projectCwdById = new Map(projects.map((project) => [project.id, project.cwd] as const));
  const projectById = new Map(activeProjects.map((project) => [project.id, project] as const));
  const savedBoardItems = savedBoards.map((split) =>
    buildSidebarBoardListItem({
      projectById,
      split,
      threadById: sidebarThreadsById,
    }),
  );
  const visibleSavedBoardItems = savedBoardItems.slice(0, splitRevealCount);
  const pickerEnvironments = ((): ProjectPickerEnvironment[] => {
    const uniqueByConnection = new Map<string, ProjectPickerEnvironment>();
    const connectedHostIds = new Set(projectPickerConnectedHostIds);
    const localConnectionDescriptor = describeHostConnection(localDeviceHost);

    uniqueByConnection.set(localDeviceConnectionUrl, {
      id: "local-device",
      name: "This device",
      subtitle: localConnectionDescriptor.summary,
      connectionUrl: localDeviceConnectionUrl,
      icon: {
        glyph: "terminal",
        color: "blue",
      },
      isLocal: true,
      isConnected: true,
    });

    for (const host of projectPickerRemoteHosts) {
      if (!connectedHostIds.has(host.id)) {
        continue;
      }
      const connectionUrl = resolveHostConnectionWsUrl(host);
      if (uniqueByConnection.has(connectionUrl)) {
        continue;
      }
      const connectionDescriptor = describeHostConnection({
        wsUrl: host.wsUrl,
        authToken: host.authToken,
      });
      uniqueByConnection.set(connectionUrl, {
        id: host.id,
        name: host.name,
        subtitle:
          connectionDescriptor.kind === "relay"
            ? `${connectionDescriptor.summary} · ${connectionDescriptor.detail}`
            : connectionDescriptor.summary,
        connectionUrl,
        icon:
          host.iconGlyph && host.iconColor
            ? {
                glyph: host.iconGlyph,
                color: host.iconColor,
              }
            : null,
        isLocal: false,
        isConnected: true,
      });
    }

    return [...uniqueByConnection.values()];
  })();
  const selectedProjectPickerEnvironment = (() => {
    if (projectPickerSelectedConnectionUrl === null) {
      return pickerEnvironments[0] ?? null;
    }
    return (
      pickerEnvironments.find(
        (environment) => environment.connectionUrl === projectPickerSelectedConnectionUrl,
      ) ??
      pickerEnvironments[0] ??
      null
    );
  })();
  const selectedProjectPickerConnectionUrl =
    selectedProjectPickerEnvironment?.connectionUrl ?? localDeviceConnectionUrl;
  const selectedProjectPickerIsLocal = selectedProjectPickerEnvironment?.isLocal ?? true;
  const selectedProjectPickerName = selectedProjectPickerEnvironment?.name ?? "remote host";
  const normalizedProjectPickerEnvironmentQuery = projectPickerEnvironmentQuery
    .trim()
    .toLowerCase();
  const filteredPickerEnvironments = (() => {
    if (normalizedProjectPickerEnvironmentQuery.length === 0) {
      return pickerEnvironments;
    }
    return pickerEnvironments.filter(
      (environment) =>
        environment.name.toLowerCase().includes(normalizedProjectPickerEnvironmentQuery) ||
        environment.subtitle.toLowerCase().includes(normalizedProjectPickerEnvironmentQuery),
    );
  })();
  const reconcileThreadDerivedState = useStableCallback(() => {
    const threads = useStore.getState().threads;
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
    clearPromotedDraftThreads(threads.map((thread) => thread.id));
  });
  const clearRemoteSnapshotMergeHandle = useStableCallback(() => {
    remoteSnapshotMergeScheduledRef.current = false;
    const handle = remoteSnapshotMergeHandleRef.current;
    if (!handle) {
      return;
    }
    remoteSnapshotMergeHandleRef.current = null;
    if (handle.kind === "idle") {
      const idleWindow = window as Window & {
        readonly cancelIdleCallback?: (handleId: number) => void;
      };
      idleWindow.cancelIdleCallback?.(handle.id);
      return;
    }
    window.clearTimeout(handle.id);
  });
  const flushRemoteSnapshotMergeQueue = useStableCallback(() => {
    remoteSnapshotMergeScheduledRef.current = false;
    remoteSnapshotMergeHandleRef.current = null;
    const pending = pendingRemoteSnapshotMergeByConnectionRef.current;
    if (pending.size === 0) {
      return;
    }

    const merges = [...pending.entries()];
    pending.clear();
    for (const [connectionUrl, snapshot] of merges) {
      useStore.getState().syncServerShellSnapshot(snapshot);
      useHostConnectionStore.getState().upsertSnapshotOwnership(connectionUrl, snapshot);
    }
    reconcileThreadDerivedState();
  });
  const scheduleRemoteSnapshotMergeFlush = useStableCallback(() => {
    if (remoteSnapshotMergeScheduledRef.current) {
      return;
    }
    remoteSnapshotMergeScheduledRef.current = true;
    const runFlush = () => {
      flushRemoteSnapshotMergeQueue();
    };
    const idleWindow = window as Window & {
      readonly requestIdleCallback?: (
        callback: (deadline: IdleDeadline) => void,
        options?: { timeout?: number },
      ) => number;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      const handleId = idleWindow.requestIdleCallback(
        () => {
          runFlush();
        },
        { timeout: REMOTE_SNAPSHOT_BACKGROUND_MERGE_TIMEOUT_MS },
      );
      remoteSnapshotMergeHandleRef.current = { kind: "idle", id: handleId };
      return;
    }
    const handleId = window.setTimeout(runFlush, REMOTE_SNAPSHOT_BACKGROUND_MERGE_DELAY_MS);
    remoteSnapshotMergeHandleRef.current = { kind: "timeout", id: handleId };
  });
  const refreshRemoteSidebarHosts = async () => {
    const existingRefresh = remoteSidebarRefreshInFlightRef.current;
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshPromise = (async () => {
      const connectedHostIds = new Set(loadConnectedRemoteHostIds());
      const connectedHosts: Array<RemoteHostInstance> = [];
      for (const host of loadRemoteHostInstances()) {
        if (
          !connectedHostIds.has(host.id) ||
          resolveHostConnectionWsUrl(host) === localDeviceConnectionUrl
        ) {
          continue;
        }
        connectedHosts.push(host);
      }
      const hosts = connectedHosts.toSorted((left, right) => left.name.localeCompare(right.name));
      const nextConnectionUrls = new Set<string>();
      for (const host of hosts) {
        nextConnectionUrls.add(resolveHostConnectionWsUrl(host));
      }
      const previousConnectionUrls = registeredRemoteRouteConnectionUrlsRef.current;
      for (const connectionUrl of nextConnectionUrls) {
        if (!previousConnectionUrls.has(connectionUrl)) {
          registerRemoteRoute(connectionUrl);
        }
      }
      for (const connectionUrl of previousConnectionUrls) {
        if (!nextConnectionUrls.has(connectionUrl)) {
          unregisterRemoteRoute(connectionUrl);
          remoteSnapshotSequenceByConnectionRef.current.delete(connectionUrl);
          pendingRemoteSnapshotMergeByConnectionRef.current.delete(connectionUrl);
          const ownership = useHostConnectionStore.getState().getOwnership(connectionUrl);
          if (ownership) {
            useStore.getState().removeReadModelEntities(ownership);
          }
          useHostConnectionStore.getState().removeConnection(connectionUrl);
        }
      }
      registeredRemoteRouteConnectionUrlsRef.current = nextConnectionUrls;

      const requestVersion = remoteSidebarRefreshVersionRef.current + 1;
      remoteSidebarRefreshVersionRef.current = requestVersion;

      if (hosts.length === 0) {
        remoteSnapshotSequenceByConnectionRef.current.clear();
        pendingRemoteSnapshotMergeByConnectionRef.current.clear();
        clearRemoteSnapshotMergeHandle();
        reconcileThreadDerivedState();
        setRemoteSidebarHosts((current) => (current.length === 0 ? current : []));
        return;
      }

      const previousEntriesByConnectionUrl = new Map(
        remoteSidebarHostsRef.current.map((entry) => [entry.connectionUrl, entry] as const),
      );
      const hostEntries = await mapWithConcurrencyLimit(
        hosts,
        REMOTE_SIDEBAR_SNAPSHOT_FETCH_CONCURRENCY,
        async (host): Promise<RemoteSidebarHostEntry> => {
          const connectionUrl = resolveHostConnectionWsUrl(host);
          const previousEntry = previousEntriesByConnectionUrl.get(connectionUrl);
          try {
            const snapshot = await routeOrchestrationGetShellSnapshotFromRemote(connectionUrl);
            const previousSequence =
              remoteSnapshotSequenceByConnectionRef.current.get(connectionUrl);
            const hasNewSnapshot = previousSequence !== snapshot.snapshotSequence;
            if (hasNewSnapshot) {
              pendingRemoteSnapshotMergeByConnectionRef.current.set(connectionUrl, snapshot);
              remoteSnapshotSequenceByConnectionRef.current.set(
                connectionUrl,
                snapshot.snapshotSequence,
              );
            } else if (previousEntry) {
              return previousEntry;
            }
            const mappedProjects = mapRemoteProjectsFromSnapshot(snapshot, sidebarProjectSortOrder);
            const projects = previousEntry
              ? reuseRemoteProjectEntries(previousEntry.projects, mappedProjects)
              : mappedProjects;
            const availableEntry: RemoteSidebarHostEntry = {
              host,
              connectionUrl,
              status: "available",
              projects,
            };
            return previousEntry && remoteSidebarHostEntryEquals(previousEntry, availableEntry)
              ? previousEntry
              : availableEntry;
          } catch (error) {
            const fallbackProjects = previousEntry?.projects ?? [];
            const unavailableEntry: RemoteSidebarHostEntry =
              error instanceof Error
                ? {
                    host,
                    connectionUrl,
                    status: "unavailable",
                    projects: fallbackProjects,
                    error: error.message,
                  }
                : {
                    host,
                    connectionUrl,
                    status: "unavailable",
                    projects: fallbackProjects,
                  };
            return previousEntry && remoteSidebarHostEntryEquals(previousEntry, unavailableEntry)
              ? previousEntry
              : unavailableEntry;
          }
        },
      );
      if (pendingRemoteSnapshotMergeByConnectionRef.current.size > 0) {
        scheduleRemoteSnapshotMergeFlush();
      }

      if (remoteSidebarRefreshVersionRef.current !== requestVersion) {
        return;
      }
      setRemoteSidebarHosts((current) =>
        remoteSidebarHostEntriesEqual(current, hostEntries) ? current : hostEntries,
      );
    })();

    remoteSidebarRefreshInFlightRef.current = refreshPromise;
    try {
      await refreshPromise;
    } catch (error) {
      if (remoteSidebarRefreshInFlightRef.current === refreshPromise) {
        remoteSidebarRefreshInFlightRef.current = null;
      }
      throw error;
    }
    if (remoteSidebarRefreshInFlightRef.current === refreshPromise) {
      remoteSidebarRefreshInFlightRef.current = null;
    }
  };
  const refreshRemoteSidebarHostsEffect = useEffectEvent(refreshRemoteSidebarHosts);
  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }
    const pendingRemoteSnapshotMergeByConnection =
      pendingRemoteSnapshotMergeByConnectionRef.current;
    let cancelled = false;
    let timeoutHandle: number | null = null;
    const resolveRefreshDelay = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? REMOTE_HOST_HIDDEN_REFRESH_INTERVAL_MS
        : REMOTE_HOST_REFRESH_INTERVAL_MS;

    const schedule = (delayMs = resolveRefreshDelay()) => {
      if (cancelled) {
        return;
      }
      timeoutHandle = window.setTimeout(() => {
        void tick();
      }, delayMs);
    };

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        await refreshRemoteSidebarHostsEffect();
      } catch (error) {
        schedule(resolveRefreshDelay());
        throw error;
      }
      schedule(resolveRefreshDelay());
    };

    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      void tick();
    };

    schedule(REMOTE_HOST_INITIAL_RESOLVE_DELAY_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const registeredRemoteRouteConnectionUrls = registeredRemoteRouteConnectionUrlsRef.current;
    return () => {
      cancelled = true;
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
      clearRemoteSnapshotMergeHandle();
      pendingRemoteSnapshotMergeByConnection.clear();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const connectionUrl of registeredRemoteRouteConnectionUrls) {
        unregisterRemoteRoute(connectionUrl);
      }
      registeredRemoteRouteConnectionUrls.clear();
    };
  }, [bootstrapComplete, clearRemoteSnapshotMergeHandle]);
  const configuredBaseDirectory = configuredAddProjectBaseDirectory.trim();
  const addProjectBaseDirectory =
    configuredBaseDirectory.length > 0 ? configuredBaseDirectory : "~";
  const editingProject = editingProjectId
    ? (projects.find((project) => project.id === editingProjectId) ?? null)
    : null;
  const editingRemoteProject = (() => {
    if (!editingProjectId || !editingProjectConnectionUrl) {
      return null;
    }
    return (
      remoteSidebarHosts
        .find(
          (entry) =>
            normalizeWsUrl(entry.connectionUrl) === normalizeWsUrl(editingProjectConnectionUrl),
        )
        ?.projects.find((project) => project.id === editingProjectId) ?? null
    );
  })();
  const editingProjectTarget = editingProject ?? editingRemoteProject;
  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const sidebarShortcutLabelOptions = {
    platform,
    context: {
      terminalFocus: false,
      terminalOpen: routeTerminalOpen,
    },
  };

  const removeRemoteThreadFromSidebarById = (input: {
    connectionUrl: string;
    threadId: ThreadId;
  }) => {
    const normalizedConnectionUrl = normalizeWsUrl(input.connectionUrl);
    setRemoteSidebarHosts((current) => {
      let changed = false;
      const nextHosts = current.map((entry) => {
        if (!connectionUrlsEqual(entry.connectionUrl, normalizedConnectionUrl)) {
          return entry;
        }
        let projectChanged = false;
        const nextProjects = entry.projects.map((project) => {
          const nextThreads = project.threads.filter((thread) => thread.id !== input.threadId);
          if (nextThreads.length === project.threads.length) {
            return project;
          }
          projectChanged = true;
          return {
            ...project,
            threads: nextThreads,
          };
        });
        if (!projectChanged) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          projects: nextProjects,
        };
      });
      return changed ? nextHosts : current;
    });
    removeFromSelection([input.threadId]);
  };
  const attemptArchiveThread = async (threadId: ThreadId, connectionUrl: string) => {
    const isRemoteThread = !connectionUrlsEqual(connectionUrl, localDeviceConnectionUrl);
    if (isRemoteThread) {
      removeRemoteThreadFromSidebarById({ connectionUrl, threadId });
    }
    try {
      await archiveThread(threadId);
    } catch (error) {
      if (isRemoteThread) {
        refreshRemoteSidebarHosts().catch(() => undefined);
      }
      toastManager.add({
        type: "error",
        title: "Failed to archive thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    if (isRemoteThread) {
      refreshRemoteSidebarHosts().catch(() => undefined);
    }
  };

  const focusMostRecentThreadForProject = (projectId: ProjectId) => {
    const sourceThreads = threadIdsByProjectId[projectId] ?? [];
    const filteredThreads: SidebarThreadSummary[] = [];
    for (const threadId of sourceThreads) {
      const thread = sidebarThreadsById[threadId];
      if (thread === undefined || thread.archivedAt !== null) {
        continue;
      }
      filteredThreads.push(thread);
    }
    const sortedThreads = sortThreadsForSidebar(filteredThreads, sidebarThreadSortOrder);
    const latestThread = sortedThreads[0];
    if (!latestThread) return;

    void navigate({
      to: "/$threadId",
      params: { threadId: latestThread.id },
    });
  };

  const refreshProjectBrowse = async (partialPath: string) => {
    const trimmedPath = partialPath.trim();
    if (!addingProject || projectPickerStep !== "directory" || !trimmedPath) {
      dispatchProjectPickerBrowseUiState({ type: "reset-project-browse-ui" });
      return;
    }

    const requestVersion = browseRequestVersionRef.current + 1;
    browseRequestVersionRef.current = requestVersion;
    dispatchProjectPickerBrowseUiState({ type: "project-browse-start", path: trimmedPath });
    try {
      const browseResult = await routeFilesystemBrowseToRemote(selectedProjectPickerConnectionUrl, {
        partialPath: trimmedPath,
      });
      if (browseRequestVersionRef.current === requestVersion) {
        dispatchProjectPickerBrowseUiState({
          type: "project-browse-success",
          path: trimmedPath,
          result: browseResult,
        });
        dispatchProjectPickerBrowseUiState({ type: "project-browse-finish" });
      }
    } catch (error) {
      if (browseRequestVersionRef.current === requestVersion) {
        dispatchProjectPickerBrowseUiState({
          type: "project-browse-failure",
          path: trimmedPath,
          error: error instanceof Error ? error.message : "Unable to browse this directory path.",
        });
        dispatchProjectPickerBrowseUiState({ type: "project-browse-finish" });
      }
    }
  };
  const refreshProjectBrowseEffect = useEffectEvent(refreshProjectBrowse);

  useEffect(() => {
    if (!addingProject || projectPickerStep !== "directory") {
      dispatchProjectPickerBrowseUiState({ type: "reset-project-browse-ui" });
      return;
    }
    const trimmedPath = newCwd.trim();
    if (!trimmedPath) {
      dispatchProjectPickerBrowseUiState({ type: "reset-project-browse-ui" });
      return;
    }
    void refreshProjectBrowseEffect(trimmedPath);
  }, [addingProject, newCwd, projectPickerStep]);

  useEffect(() => {
    if (!addingProject) {
      return;
    }
    addProjectInputRef.current?.focus();
  }, [addingProject]);

  const addProjectFromPath = async (rawCwd: string, options?: { revealOnError?: boolean }) => {
    const isLocalEnvironment = selectedProjectPickerIsLocal;
    const targetConnectionUrl = selectedProjectPickerConnectionUrl;
    const cwd = resolveProjectPath(
      rawCwd,
      isLocalEnvironment ? addProjectBaseDirectory : undefined,
    ).trim();
    if (!cwd || isAddingProject) return;

    dispatchProjectPickerState({ type: "set-is-adding-project", isAddingProject: true });
    const finishAddingProject = () => {
      dispatchProjectPickerState({ type: "set-is-adding-project", isAddingProject: false });
      dispatchProjectPickerState({ type: "set-new-cwd", newCwd: "" });
      setAddProjectError(null);
      setProjectBrowseState(EMPTY_PROJECT_BROWSE_STATE);
      setActiveProjectBrowseIndex(-1);
      dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
    };

    const shouldUseLocalProjectDedup = isLocalEnvironment;
    const existing = shouldUseLocalProjectDedup ? findExistingProjectByPath(projects, cwd) : null;
    if (existing) {
      try {
        if (existing.archivedAt !== null) {
          await routeOrchestrationDispatchCommandToRemote(localDeviceConnectionUrl, {
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId: existing.id,
            archivedAt: null,
          });
        }
        focusMostRecentThreadForProject(existing.id);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to restore "${existing.name}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishAddingProject();
      return;
    }

    const projectId = newProjectId();
    const createdAt = new Date().toISOString();
    const title = inferProjectTitle(cwd) || cwd;
    try {
      const defaultModelSelection = {
        provider: "codex" as const,
        model: getDefaultServerModel(providerStatuses, "codex"),
      };
      await routeOrchestrationDispatchCommandToRemote(targetConnectionUrl, {
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title,
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection,
        createdAt,
      });
      if (isLocalEnvironment) {
        useStore.getState().applyOrchestrationEvent(
          createOptimisticProjectCreatedEvent({
            projectId,
            title,
            workspaceRoot: cwd,
            createdAt,
            defaultModelSelection,
          }),
        );
      }
      finishAddingProject();
      refreshRemoteSidebarHosts().catch(() => undefined);
      if (!isLocalEnvironment) {
        toastManager.add({
          type: "success",
          title: `Added project on ${selectedProjectPickerName}.`,
        });
      } else {
        handleNewThread(projectId, {
          envMode: defaultThreadEnvMode,
        }).catch((error) => {
          reportBackgroundError("Failed to create the initial thread for the new project.", error);
        });
      }
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "An error occurred while adding the project.";
      dispatchProjectPickerState({ type: "set-is-adding-project", isAddingProject: false });
      dispatchProjectPickerState({ type: "set-new-cwd", newCwd: cwd });
      if (options?.revealOnError) {
        dispatchProjectPickerState({ type: "set-adding-project", addingProject: true });
      }
      setAddProjectError(description);
      return;
    }
    finishAddingProject();
  };

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject =
    projectPickerStep === "directory" && newCwd.trim().length > 0 && !isAddingProject;
  const currentProjectBrowsePath = newCwd.trim();
  const currentProjectBrowseResult =
    projectBrowseState.loadedPath !== null &&
    projectBrowseState.loadedPath === currentProjectBrowsePath
      ? projectBrowseState.result
      : null;
  const projectPickerItemCount =
    projectPickerStep === "environment"
      ? filteredPickerEnvironments.length
      : (currentProjectBrowseResult?.entries.length ?? 0);
  const resolvedActiveProjectBrowseIndex =
    !addingProject || projectPickerItemCount === 0
      ? -1
      : activeProjectBrowseIndex < 0
        ? 0
        : Math.min(activeProjectBrowseIndex, projectPickerItemCount - 1);
  const isWaitingForCurrentProjectBrowse =
    projectPickerStep === "directory" &&
    currentProjectBrowsePath.length > 0 &&
    currentProjectBrowseResult === null &&
    addProjectError === null;

  const handleBrowseProjectEntry = (fullPath: string) => {
    setAddProjectError(null);
    dispatchProjectPickerState({
      type: "set-new-cwd",
      newCwd: toBrowseDirectoryPath(fullPath),
    });
  };

  const handleBrowseParentPath = () => {
    const currentPath = currentProjectBrowseResult?.parentPath ?? newCwd.trim();
    if (!currentPath) {
      return;
    }
    const nextPath = parentPath(currentPath);
    if (!nextPath || nextPath === currentPath) {
      return;
    }
    dispatchProjectPickerState({
      type: "set-new-cwd",
      newCwd: toBrowseDirectoryPath(nextPath),
    });
    setAddProjectError(null);
  };

  const shouldResolveProjectPathAsLocal = selectedProjectPickerIsLocal;
  const normalizedResolvedProjectPath = resolveProjectPath(
    newCwd,
    shouldResolveProjectPathAsLocal ? addProjectBaseDirectory : undefined,
  )
    .trim()
    .toLowerCase();
  const isBrowsePathExactDirectoryMatch = (() => {
    const trimmedPath = newCwd.trim();
    if (!trimmedPath) {
      return false;
    }
    if (/[\\/]$/.test(trimmedPath) || trimmedPath === "~") {
      return true;
    }
    return (
      currentProjectBrowseResult?.entries.some(
        (entry) => entry.fullPath.trim().toLowerCase() === normalizedResolvedProjectPath,
      ) ?? false
    );
  })();
  const addProjectActionLabel = isAddingProject
    ? "Adding..."
    : isBrowsePathExactDirectoryMatch
      ? "Add"
      : "Create & Add";

  const handleSelectProjectPickerEnvironment = async (environment: ProjectPickerEnvironment) => {
    if (projectPickerEnvironmentProbeId !== null) {
      return;
    }
    setAddProjectError(null);
    if (!environment.isLocal) {
      dispatchProjectPickerState({
        type: "set-project-picker-environment-probe-id",
        projectPickerEnvironmentProbeId: environment.id,
      });
      registerRemoteRoute(environment.connectionUrl);
      let availability: Awaited<ReturnType<typeof probeRemoteRouteAvailability>>;
      try {
        availability = await probeRemoteRouteAvailability(environment.connectionUrl, {
          force: true,
        });
      } catch (error) {
        dispatchProjectPickerState({
          type: "set-project-picker-environment-probe-id",
          projectPickerEnvironmentProbeId: null,
        });
        throw error;
      }
      dispatchProjectPickerState({
        type: "set-project-picker-environment-probe-id",
        projectPickerEnvironmentProbeId: null,
      });
      if (availability.status !== "available") {
        setAddProjectError(
          availability.error?.trim().length
            ? availability.error
            : `Unable to reach ${environment.name}. We'll keep pinging it in the background.`,
        );
        return;
      }
    }
    dispatchProjectPickerState({
      type: "set-project-picker-selected-connection-url",
      projectPickerSelectedConnectionUrl: environment.connectionUrl,
    });
    dispatchProjectPickerState({
      type: "set-project-picker-step",
      projectPickerStep: "directory",
    });
    const initialPath = environment.isLocal ? addProjectBaseDirectory : "~";
    dispatchProjectPickerState({
      type: "set-new-cwd",
      newCwd: toBrowseDirectoryPath(initialPath),
    });
    setProjectBrowseState(EMPTY_PROJECT_BROWSE_STATE);
    setAddProjectError(null);
    dispatchProjectPickerState({
      type: "set-project-picker-environment-query",
      projectPickerEnvironmentQuery: "",
    });
    setActiveProjectBrowseIndex(-1);
  };

  const handleAddProjectInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (projectPickerStep === "environment") {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveProjectBrowseIndex((index) => {
          if (filteredPickerEnvironments.length === 0) {
            return -1;
          }
          return Math.min(index + 1, filteredPickerEnvironments.length - 1);
        });
        if (filteredPickerEnvironments.length > 0) {
          requestProjectPickerKeyboardScroll(event.timeStamp);
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveProjectBrowseIndex((index) => {
          if (filteredPickerEnvironments.length === 0) {
            return -1;
          }
          return index <= 0 ? 0 : index - 1;
        });
        if (filteredPickerEnvironments.length > 0) {
          requestProjectPickerKeyboardScroll(event.timeStamp);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const environment =
          resolvedActiveProjectBrowseIndex >= 0
            ? filteredPickerEnvironments[resolvedActiveProjectBrowseIndex]
            : filteredPickerEnvironments[0];
        if (environment) {
          void handleSelectProjectPickerEnvironment(environment);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
        setAddProjectError(null);
        dispatchProjectPickerState({
          type: "set-project-picker-environment-probe-id",
          projectPickerEnvironmentProbeId: null,
        });
        return;
      }
      if (event.key === "Backspace" && projectPickerEnvironmentQuery.trim().length === 0) {
        event.preventDefault();
        dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
        setAddProjectError(null);
        dispatchProjectPickerState({
          type: "set-project-picker-environment-probe-id",
          projectPickerEnvironmentProbeId: null,
        });
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveProjectBrowseIndex((index) => {
        const entryCount = currentProjectBrowseResult?.entries.length ?? 0;
        if (entryCount === 0) {
          return -1;
        }
        return Math.min(index + 1, entryCount - 1);
      });
      if ((currentProjectBrowseResult?.entries.length ?? 0) > 0) {
        requestProjectPickerKeyboardScroll(event.timeStamp);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveProjectBrowseIndex((index) => {
        const entryCount = currentProjectBrowseResult?.entries.length ?? 0;
        if (entryCount === 0) {
          return -1;
        }
        return index <= 0 ? 0 : index - 1;
      });
      if ((currentProjectBrowseResult?.entries.length ?? 0) > 0) {
        requestProjectPickerKeyboardScroll(event.timeStamp);
      }
      return;
    }
    if (event.key === "ArrowRight") {
      const selectedEntry =
        resolvedActiveProjectBrowseIndex >= 0
          ? currentProjectBrowseResult?.entries[resolvedActiveProjectBrowseIndex]
          : undefined;
      if (selectedEntry) {
        event.preventDefault();
        handleBrowseProjectEntry(selectedEntry.fullPath);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      handleBrowseParentPath();
      return;
    }
    if (event.key === "Backspace") {
      if (event.currentTarget.value.trim().length === 0 && pickerEnvironments.length > 1) {
        event.preventDefault();
        dispatchProjectPickerState({
          type: "set-project-picker-step",
          projectPickerStep: "environment",
        });
        dispatchProjectPickerState({
          type: "set-project-picker-environment-query",
          projectPickerEnvironmentQuery: "",
        });
        setActiveProjectBrowseIndex(0);
        requestProjectPickerKeyboardScroll(event.timeStamp);
        return;
      }
      const target = event.currentTarget;
      const hasSelection = target.selectionStart !== target.selectionEnd;
      const cursorAtEnd = target.selectionStart === target.value.length;
      if (!hasSelection && cursorAtEnd && /[\\/]$/.test(target.value.trim())) {
        event.preventDefault();
        handleBrowseParentPath();
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddProject();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
      setAddProjectError(null);
      dispatchProjectPickerState({
        type: "set-project-picker-environment-probe-id",
        projectPickerEnvironmentProbeId: null,
      });
    }
  };

  useEffect(() => {
    if (
      !addingProject ||
      resolvedActiveProjectBrowseIndex < 0 ||
      projectPickerKeyboardNavigationId === 0
    ) {
      return;
    }
    const listElement = projectPickerListRef.current;
    if (!listElement) {
      return;
    }
    const stepSelector =
      projectPickerStep === "environment"
        ? "data-project-picker-environment-index"
        : "data-project-picker-index";
    const activeItem = listElement.querySelector<HTMLElement>(
      `[${stepSelector}="${String(resolvedActiveProjectBrowseIndex)}"]`,
    );
    if (!activeItem) {
      return;
    }
    activeItem.scrollIntoView({
      block: "center",
      behavior: "auto",
    });
  }, [
    addingProject,
    projectPickerKeyboardNavigationId,
    projectPickerStep,
    resolvedActiveProjectBrowseIndex,
  ]);

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldShowProjectPathEntry) {
      dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
      dispatchProjectPickerState({
        type: "set-project-picker-environment-probe-id",
        projectPickerEnvironmentProbeId: null,
      });
      return;
    }
    const remoteHosts = loadRemoteHostInstances();
    const connectedHostIds = loadConnectedRemoteHostIds();
    const connectedHostIdSet = new Set(connectedHostIds);
    for (const host of remoteHosts) {
      if (!connectedHostIdSet.has(host.id)) {
        continue;
      }
      const connectionUrl = resolveHostConnectionWsUrl(host);
      if (connectionUrl === localDeviceConnectionUrl) {
        continue;
      }
      registerRemoteRoute(connectionUrl);
    }
    dispatchProjectPickerState({
      type: "set-project-picker-remote-hosts",
      projectPickerRemoteHosts: remoteHosts,
    });
    dispatchProjectPickerState({
      type: "set-project-picker-connected-host-ids",
      projectPickerConnectedHostIds: connectedHostIds,
    });
    dispatchProjectPickerState({
      type: "set-project-picker-selected-connection-url",
      projectPickerSelectedConnectionUrl: localDeviceConnectionUrl,
    });
    const hasRemoteEnvironment = remoteHosts.some(
      (host) =>
        connectedHostIdSet.has(host.id) &&
        resolveHostConnectionWsUrl(host) !== localDeviceConnectionUrl,
    );
    const initialPath = addProjectBaseDirectory;
    dispatchProjectPickerState({
      type: "set-project-picker-step",
      projectPickerStep: hasRemoteEnvironment ? "environment" : "directory",
    });
    dispatchProjectPickerState({
      type: "set-project-picker-environment-query",
      projectPickerEnvironmentQuery: "",
    });
    dispatchProjectPickerState({
      type: "set-new-cwd",
      newCwd: hasRemoteEnvironment ? "" : toBrowseDirectoryPath(initialPath),
    });
    setProjectBrowseState(EMPTY_PROJECT_BROWSE_STATE);
    setActiveProjectBrowseIndex(-1);
    dispatchProjectPickerState({ type: "set-adding-project", addingProject: true });
  };
  const handleStartAddProjectEffect = useEffectEvent(() => {
    handleStartAddProject();
  });
  useEffect(() => {
    window.addEventListener(SIDEBAR_ADD_PROJECT_REQUEST_EVENT, handleStartAddProjectEffect);
    return () => {
      window.removeEventListener(SIDEBAR_ADD_PROJECT_REQUEST_EVENT, handleStartAddProjectEffect);
    };
  }, []);

  const cancelRename = () => {
    dispatchSidebarEditorState({ type: "clear-thread-rename" });
    renamingInputRef.current = null;
  };

  const commitRename = async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
    const finishRename = () => {
      dispatchSidebarEditorState({
        type: "clear-thread-rename-if-match",
        renamingThreadId: threadId,
      });
      renamingInputRef.current = null;
    };

    const trimmed = newTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      finishRename();
      return;
    }
    if (trimmed === originalTitle) {
      finishRename();
      return;
    }
    try {
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        title: trimmed,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
    finishRename();
  };
  const localThreadRenameTarget = renamingThreadId
    ? (readSidebarThreadSummary(renamingThreadId) ?? null)
    : null;
  const saveLocalThreadRename = async (nextTitle: string) => {
    const target = localThreadRenameTarget;
    if (!target) {
      cancelRename();
      return true;
    }
    const trimmed = nextTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Chat title cannot be empty",
      });
      return false;
    }
    if (trimmed === target.title) {
      cancelRename();
      return true;
    }
    try {
      const api = readNativeApi();
      if (!api) {
        cancelRename();
        return true;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: target.id,
        title: trimmed,
      });
      cancelRename();
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return false;
    }
  };

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleThreadContextMenu = async (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => {
    const api = readNativeApi();
    if (!api) return;
    const thread = readSidebarThreadSummary(threadId);
    if (!thread) return;
    const threadWorkspacePath = thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
    const clicked = await api.contextMenu.show(
      [
        { id: "open-in-board", label: "Open in split" },
        { id: "pin", label: pinnedThreadIds.includes(threadId) ? "Unpin thread" : "Pin thread" },
        { id: "rename", label: "Rename thread" },
        { id: "mark-unread", label: "Mark unread" },
        { id: "copy-path", label: "Copy Path" },
        { id: "copy-thread-id", label: "Copy Thread ID" },
        ...(thread.worktreePath
          ? [
              {
                id: "delete-worktree",
                label: "Delete worktree and chats",
                destructive: true,
              },
            ]
          : []),
        { id: "delete", label: "Delete", destructive: true },
      ],
      position,
    );

    if (clicked === "open-in-board") {
      const connectionUrl = resolveConnectionForThreadId(threadId) ?? null;
      openThreadInSplit({
        connectionUrl,
        title: thread.title ?? null,
        threadId,
      });
      return;
    }

    if (clicked === "pin") {
      togglePinnedThread(threadId);
      return;
    }

    if (clicked === "rename") {
      dispatchSidebarEditorState({
        type: "start-thread-rename",
        renamingThreadId: threadId,
        renamingTitle: thread.title,
      });
      renamingCommittedRef.current = false;
      return;
    }

    if (clicked === "mark-unread") {
      markThreadUnread(threadId, thread.latestTurn?.completedAt);
      return;
    }
    if (clicked === "copy-path") {
      if (!threadWorkspacePath) {
        toastManager.add({
          type: "error",
          title: "Path unavailable",
          description: "This thread does not have a workspace path to copy.",
        });
        return;
      }
      copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
      return;
    }
    if (clicked === "copy-thread-id") {
      copyThreadIdToClipboard(threadId, { threadId });
      return;
    }
    if (clicked === "delete-worktree") {
      await deleteWorktreeAndRelatedThreads(threadId);
      return;
    }
    if (clicked !== "delete") return;
    if (confirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete thread "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }
    }
    await deleteThread(threadId);
  };

  const handleMultiSelectContextMenu = async (position: { x: number; y: number }) => {
    const api = readNativeApi();
    if (!api) return;
    const ids = [...selectedThreadIds];
    if (ids.length === 0) return;
    const count = ids.length;

    const clicked = await api.contextMenu.show(
      [
        { id: "open-in-board", label: `Open in split (${count})` },
        { id: "mark-unread", label: `Mark unread (${count})` },
        { id: "delete", label: `Delete (${count})`, destructive: true },
      ],
      position,
    );

    if (clicked === "open-in-board") {
      const boardInputs = ids.map((id) => ({
        connectionUrl: resolveConnectionForThreadId(id) ?? null,
        threadId: id,
        title: sidebarThreadsById[id]?.title ?? null,
      }));
      openThreadsInSplit(boardInputs);
      clearSelection();
      return;
    }

    if (clicked === "mark-unread") {
      for (const id of ids) {
        const thread = readSidebarThreadSummary(id);
        markThreadUnread(id, thread?.latestTurn?.completedAt);
      }
      clearSelection();
      return;
    }

    if (clicked !== "delete") return;

    if (confirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete ${count} thread${count === 1 ? "" : "s"}?`,
          "This permanently clears conversation history for these threads.",
        ].join("\n"),
      );
      if (!confirmed) return;
    }

    const deletedIds = new Set<ThreadId>(ids);
    await Promise.all(ids.map((id) => deleteThread(id, { deletedThreadIds: deletedIds })));
    removeFromSelection(ids);
  };

  const prefetchThreadHistory = useStableCallback(
    (
      threadId: ThreadId,
      options?: {
        readonly hydrateStore?: boolean;
        readonly prewarmRows?: boolean;
        readonly priority?: "background" | "immediate";
      },
    ): Promise<void> => {
      const thread = readSidebarThreadSummary(threadId);
      if (!thread) {
        return Promise.resolve();
      }
      if (isThreadLiveWorkActive(thread)) {
        return Promise.resolve();
      }
      const priority = options?.priority ?? "immediate";
      const shouldHydrateStore = options?.hydrateStore === true;
      const shouldPrewarmRows = options?.prewarmRows !== false;
      if (priority === "background" && shouldAvoidSpeculativeWork()) {
        return Promise.resolve();
      }
      const expectedUpdatedAt = thread.updatedAt ?? null;
      const prefetchTimelineRows = () => {
        if (!shouldPrewarmRows) {
          return Promise.resolve();
        }
        const prefetch = startThreadTimelineRowsOpenPrefetch({ threadId, priority });
        return prefetch.done
          .then(() => undefined)
          .catch((error) => {
            reportBackgroundError("Failed to prefetch thread timeline rows.", error);
          });
      };
      const storeThread = useStore.getState().threadsById?.[threadId];
      if (
        storeThread &&
        storeThread.historyLoaded !== false &&
        (expectedUpdatedAt === null || storeThread.updatedAt === expectedUpdatedAt)
      ) {
        return prefetchTimelineRows();
      }

      const cached = readCachedHydratedThread(threadId, expectedUpdatedAt);
      if (cached) {
        primeThreadTimelineRowsMetadataFromReadModelThread(cached);
        if (shouldHydrateStore) {
          startTransition(() => {
            useStore.getState().hydrateThreadFromReadModel(cached);
          });
        }
        return prefetchTimelineRows();
      }
      if (shouldPrewarmRows && !shouldHydrateStore) {
        return prefetchTimelineRows();
      }

      if (shouldHydrateStore) {
        let request = threadHistoryPrefetchByThreadIdRef.current.get(threadId);
        if (!request) {
          request = hydrateThreadFromCache(threadId, { expectedUpdatedAt });
          threadHistoryPrefetchByThreadIdRef.current.set(threadId, request);
          void request
            .finally(() => {
              if (threadHistoryPrefetchByThreadIdRef.current.get(threadId) === request) {
                threadHistoryPrefetchByThreadIdRef.current.delete(threadId);
              }
            })
            .catch(() => undefined);
        }

        const timelineRowsRequest = prefetchTimelineRows();
        const threadHydrationRequest = request
          .then((readModelThread) => {
            primeThreadTimelineRowsMetadataFromReadModelThread(readModelThread);
            if (shouldHydrateStore) {
              startTransition(() => {
                useStore.getState().hydrateThreadFromReadModel(readModelThread);
              });
            }
          })
          .catch((error) => {
            reportBackgroundError("Failed to prefetch thread history.", error);
          });
        return Promise.all([threadHydrationRequest, timelineRowsRequest]).then(() => undefined);
      }
      return Promise.resolve();
    },
  );

  const handleThreadClick = (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
    connectionUrl: string,
  ) => {
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const isShiftClick = event.shiftKey;

    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadId);
      return;
    }

    if (isShiftClick) {
      event.preventDefault();
      rangeSelectTo(threadId, orderedProjectThreadIds);
      return;
    }

    if (selectedThreadIds.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(threadId);
    useHostConnectionStore.getState().upsertThreadOwnership(connectionUrl, threadId);
    useChatThreadBoardStore.getState().syncRouteThread({
      connectionUrl,
      threadId,
      title: readSidebarThreadSummary(threadId)?.title ?? null,
    });
    const thread = readSidebarThreadSummary(threadId);
    const cached = thread ? readCachedHydratedThread(threadId, thread.updatedAt ?? null) : null;
    if (cached) {
      primeThreadTimelineRowsMetadataFromReadModelThread(cached);
      startTransition(() => {
        useStore.getState().hydrateThreadFromReadModel(cached);
      });
    } else {
      prefetchThreadHistory(threadId, {
        hydrateStore: false,
        prewarmRows: true,
        priority: "immediate",
      });
    }
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: buildSingleThreadRouteSearch({
          connectionUrl: connectionUrlsEqual(connectionUrl, localDeviceConnectionUrl)
            ? null
            : connectionUrl,
        }),
      });
    });
  };

  const navigateToThread = (threadId: ThreadId) => {
    const thread = readSidebarThreadSummary(threadId);
    const cached = thread ? readCachedHydratedThread(threadId, thread.updatedAt ?? null) : null;
    if (cached) {
      primeThreadTimelineRowsMetadataFromReadModelThread(cached);
      startTransition(() => {
        useStore.getState().hydrateThreadFromReadModel(cached);
      });
    } else {
      prefetchThreadHistory(threadId, {
        hydrateStore: false,
        prewarmRows: true,
        priority: "immediate",
      });
    }
    if (selectedThreadIds.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(threadId);
    useChatThreadBoardStore.getState().syncRouteThread({
      threadId,
      title: thread?.title ?? null,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: buildSingleThreadRouteSearch(),
      });
    });
  };
  const navigateToThreadEffect = useEffectEvent((threadId: ThreadId) => {
    navigateToThread(threadId);
  });
  const navigateToThreadOnConnection = (connectionUrl: string, threadId: ThreadId) => {
    if (selectedThreadIds.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(threadId);
    useHostConnectionStore.getState().upsertThreadOwnership(connectionUrl, threadId);
    useChatThreadBoardStore.getState().syncRouteThread({
      connectionUrl,
      threadId,
      title: readSidebarThreadSummary(threadId)?.title ?? null,
    });
    const thread = readSidebarThreadSummary(threadId);
    const cached = thread ? readCachedHydratedThread(threadId, thread.updatedAt ?? null) : null;
    if (cached) {
      primeThreadTimelineRowsMetadataFromReadModelThread(cached);
      startTransition(() => {
        useStore.getState().hydrateThreadFromReadModel(cached);
      });
    } else {
      prefetchThreadHistory(threadId, {
        hydrateStore: false,
        prewarmRows: true,
        priority: "immediate",
      });
    }
    if (connectionUrlsEqual(connectionUrl, localDeviceConnectionUrl)) {
      navigateToThread(threadId);
      return;
    }
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: buildSingleThreadRouteSearch({ connectionUrl }),
      });
    });
  };

  const handleProjectContextMenu = async (
    projectId: ProjectId,
    position: { x: number; y: number },
  ) => {
    const api = readNativeApi();
    if (!api) return;
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;

    const clicked = await api.contextMenu.show(
      [
        {
          id: "pin",
          label: pinnedProjectIds.includes(project.id) ? "Unpin project" : "Pin project",
        },
        { id: "edit", label: "Edit project" },
        { id: "copy-path", label: "Copy Project Path" },
        { id: "archive", label: "Archive project" },
        { id: "delete", label: "Remove project", destructive: true },
      ],
      position,
    );
    if (clicked === "pin") {
      togglePinnedProject(project.id);
      return;
    }
    if (clicked === "edit") {
      dispatchSidebarEditorState({
        type: "open-project-editor",
        editingProjectId: project.id,
        editingProjectConnectionUrl: activeWsUrl,
        editingProjectName: project.name,
        editingProjectIcon: project.icon,
      });
      return;
    }
    if (clicked === "copy-path") {
      copyPathToClipboard(project.cwd, { path: project.cwd });
      return;
    }
    if (clicked === "archive") {
      const confirmed = await api.dialogs.confirm(`Archive project "${project.name}"?`);
      if (!confirmed) return;

      try {
        await routeOrchestrationDispatchCommandToRemote(activeWsUrl, {
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          archivedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error archiving project.";
        toastManager.add({
          type: "error",
          title: `Failed to archive "${project.name}"`,
          description: message,
        });
      }
      return;
    }
    if (clicked !== "delete") return;

    const projectThreadIds = threadIdsByProjectId[projectId] ?? [];
    if (projectThreadIds.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Project is not empty",
        description: "Delete all threads in this project before removing it.",
      });
      return;
    }

    const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
    if (!confirmed) return;

    try {
      const projectDraftThread = getDraftThreadByProjectId(projectId);
      if (projectDraftThread) {
        clearComposerDraftForThread(projectDraftThread.threadId);
      }
      clearProjectDraftThreadId(projectId);
      await routeOrchestrationDispatchCommandToRemote(activeWsUrl, {
        type: "project.delete",
        commandId: newCommandId(),
        projectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error removing project.";
      console.error("Failed to remove project", { projectId, error });
      toastManager.add({
        type: "error",
        title: `Failed to remove "${project.name}"`,
        description: message,
      });
    }
  };

  const handleRemoteProjectContextMenu = async (
    input: {
      connectionUrl: string;
      project: RemoteSidebarProjectEntry;
    },
    position: { x: number; y: number },
  ) => {
    const api = readNativeApi();
    if (!api) return;

    const clicked = await api.contextMenu.show(
      [
        { id: "edit", label: "Edit project" },
        { id: "copy-path", label: "Copy Project Path" },
        { id: "archive", label: "Archive project" },
        { id: "delete", label: "Remove project", destructive: true },
      ],
      position,
    );
    if (clicked === "edit") {
      dispatchSidebarEditorState({
        type: "open-project-editor",
        editingProjectId: input.project.id,
        editingProjectConnectionUrl: input.connectionUrl,
        editingProjectName: input.project.name,
        editingProjectIcon: input.project.icon,
      });
      return;
    }
    if (clicked === "copy-path") {
      copyPathToClipboard(input.project.cwd, { path: input.project.cwd });
      return;
    }
    if (clicked === "archive") {
      const confirmed = await api.dialogs.confirm(`Archive project "${input.project.name}"?`);
      if (!confirmed) return;
      try {
        await routeOrchestrationDispatchCommandToRemote(input.connectionUrl, {
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: input.project.id,
          archivedAt: new Date().toISOString(),
        });
        await refreshRemoteSidebarHosts();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to archive "${input.project.name}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    if (clicked !== "delete") return;
    if (input.project.threads.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Project is not empty",
        description: "Delete all threads in this project before removing it.",
      });
      return;
    }
    const confirmed = await api.dialogs.confirm(`Remove project "${input.project.name}"?`);
    if (!confirmed) return;
    try {
      await routeOrchestrationDispatchCommandToRemote(input.connectionUrl, {
        type: "project.delete",
        commandId: newCommandId(),
        projectId: input.project.id,
      });
      await refreshRemoteSidebarHosts();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to remove "${input.project.name}"`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
  const handleRemoteThreadContextMenu = async (
    input: {
      connectionUrl: string;
      project: RemoteSidebarProjectEntry;
      thread: RemoteSidebarThreadEntry;
    },
    position: { x: number; y: number },
  ) => {
    const api = readNativeApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "open-in-board", label: "Open in split" },
        { id: "rename", label: "Rename thread" },
        { id: "copy-path", label: "Copy Path" },
        { id: "copy-thread-id", label: "Copy Thread ID" },
        { id: "archive", label: "Archive thread" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      position,
    );

    if (clicked === "open-in-board") {
      const remoteThreadId = ThreadId.makeUnsafe(input.thread.id);
      openThreadInSplit({
        connectionUrl: input.connectionUrl,
        title: input.thread.title ?? null,
        threadId: remoteThreadId,
      });
      return;
    }

    if (clicked === "rename") {
      dispatchSidebarEditorState({
        type: "open-remote-thread-rename",
        remoteThreadRenameTarget: input,
        remoteThreadRenameTitle: input.thread.title,
      });
      return;
    }
    if (clicked === "copy-path") {
      copyPathToClipboard(input.project.cwd, { path: input.project.cwd });
      return;
    }
    if (clicked === "copy-thread-id") {
      copyThreadIdToClipboard(ThreadId.makeUnsafe(input.thread.id), {
        threadId: ThreadId.makeUnsafe(input.thread.id),
      });
      return;
    }
    if (clicked === "archive") {
      const remoteThreadId = ThreadId.makeUnsafe(input.thread.id);
      removeRemoteThreadFromSidebarById({
        connectionUrl: input.connectionUrl,
        threadId: remoteThreadId,
      });
      try {
        await routeOrchestrationDispatchCommandToRemote(input.connectionUrl, {
          type: "thread.archive",
          commandId: newCommandId(),
          threadId: remoteThreadId,
        });
        refreshRemoteSidebarHosts().catch(() => undefined);
      } catch (error) {
        refreshRemoteSidebarHosts().catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }
    if (clicked !== "delete") return;
    if (confirmThreadDelete) {
      const confirmed = await api.dialogs.confirm(
        [
          `Delete thread "${input.thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n"),
      );
      if (!confirmed) return;
    }
    const remoteThreadId = ThreadId.makeUnsafe(input.thread.id);
    removeRemoteThreadFromSidebarById({
      connectionUrl: input.connectionUrl,
      threadId: remoteThreadId,
    });
    try {
      await routeOrchestrationDispatchCommandToRemote(input.connectionUrl, {
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: remoteThreadId,
      });
      refreshRemoteSidebarHosts().catch(() => undefined);
    } catch (error) {
      refreshRemoteSidebarHosts().catch(() => undefined);
      toastManager.add({
        type: "error",
        title: "Failed to delete thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
  const closeRemoteThreadRenameDialog = () => {
    dispatchSidebarEditorState({ type: "close-remote-thread-rename" });
  };
  const saveRemoteThreadRename = async (title = remoteThreadRenameTitle) => {
    const target = remoteThreadRenameTarget;
    if (!target) {
      return true;
    }
    const nextTitle = title.trim();
    if (nextTitle.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Chat title cannot be empty",
      });
      return false;
    }
    if (nextTitle === target.thread.title) {
      closeRemoteThreadRenameDialog();
      return true;
    }
    try {
      await routeOrchestrationDispatchCommandToRemote(target.connectionUrl, {
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: ThreadId.makeUnsafe(target.thread.id),
        title: nextTitle,
      });
      await refreshRemoteSidebarHosts();
      closeRemoteThreadRenameDialog();
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return false;
    }
  };

  const closeProjectEditor = () => {
    dispatchSidebarEditorState({ type: "close-project-editor" });
  };

  const saveProjectEdits = async (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const editingTarget = editingProject ?? editingRemoteProject;
    if (!editingTarget) {
      closeProjectEditor();
      return;
    }

    const trimmedName = editingProjectName.trim();
    if (trimmedName.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project name cannot be empty",
      });
      return;
    }

    if (
      trimmedName === editingTarget.name &&
      projectIconsEqual(editingTarget.icon, editingProjectIcon)
    ) {
      closeProjectEditor();
      return;
    }

    const resolvedTargetConnectionUrl = editingProjectConnectionUrl ?? activeWsUrl;

    try {
      await routeOrchestrationDispatchCommandToRemote(resolvedTargetConnectionUrl, {
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: editingTarget.id,
        title: trimmedName,
        icon: editingProjectIcon,
      });
      await refreshRemoteSidebarHosts();
      closeProjectEditor();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to update "${editingTarget.name}"`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const handleProjectDragEnd = (event: DragEndEvent) => {
    dragInProgressRef.current = false;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeProject = orderedProjects.find((project) => project.id === active.id);
    const overProject = orderedProjects.find((project) => project.id === over.id);
    if (!activeProject || !overProject) return;
    if (sidebarProjectSortOrder !== "manual") {
      updateSettings({ sidebarProjectSortOrder: "manual" });
    }
    reorderProjects(activeProject.id, overProject.id);
  };

  const handleProjectDragStart = (_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  };

  const handleProjectDragCancel = (_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  };
  const handleProjectTitlePointerDownCapture = (event: PointerEvent<HTMLButtonElement>) => {
    suppressProjectClickForContextMenuRef.current = false;
    if (
      isContextMenuPointerDown({
        button: event.button,
        ctrlKey: event.ctrlKey,
        isMac: isMacPlatform(navigator.platform),
      })
    ) {
      // Keep context-menu gestures from arming the sortable drag sensor.
      event.stopPropagation();
    }

    suppressProjectClickAfterDragRef.current = false;
  };

  const routeIsBoard = activeStoreSplitId !== null;
  const activeThreadId = routeIsBoard ? undefined : (routeThreadId ?? undefined);
  const activeSidebarRouteThreadId = activeThreadId ?? null;
  const pinnedProjectIdSet = new Set(pinnedProjectIds);
  const pinnedThreadIdSet = new Set(pinnedThreadIds);
  const visibleProjectThreadsByProjectId = (() => {
    const next = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const project of activeProjects) {
      const projectThreads: SidebarThreadSummary[] = [];
      const threadIds = threadIdsByProjectId[project.id] ?? [];
      for (const threadId of threadIds) {
        const thread = sidebarThreadsById[threadId];
        if (!thread || thread.archivedAt !== null) {
          continue;
        }
        projectThreads.push(thread);
      }
      next.set(project.id, projectThreads);
    }
    return next;
  })();
  const projectListThreadsByProjectId = (() => {
    const next = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of visibleProjectThreadsByProjectId) {
      const unpinnedThreads = projectThreads.filter((thread) => !pinnedThreadIdSet.has(thread.id));
      next.set(
        projectId,
        unpinnedThreads.length === projectThreads.length ? projectThreads : unpinnedThreads,
      );
    }
    return next;
  })();
  const sortedProjects = (() => {
    const sortOrder = sidebarProjectSortOrder;
    const baseProjects =
      sortOrder === "manual"
        ? orderItemsByPreferredIds({
            items: sortProjectsByTimestamp(
              activeProjects,
              visibleProjectThreadsByProjectId,
              "last_user_message",
            ),
            preferredIds: projectOrder,
            getId: (project) => project.id,
          })
        : sortProjectsByTimestamp(activeProjects, visibleProjectThreadsByProjectId, sortOrder);
    return prioritizePinnedItems(baseProjects, (project) => pinnedProjectIdSet.has(project.id));
  })();
  const isProjectDraggingEnabled = normalizedProjectSearchQuery.length === 0;
  const sortedLocalProjectIds = sortedProjects.map((project) => project.id);
  const filteredLocalProjectIds = (() => {
    const unpinnedProjectIds = sortedLocalProjectIds.filter(
      (projectId) => !pinnedProjectIdSet.has(projectId),
    );
    if (normalizedProjectSearchQuery.length === 0) {
      return unpinnedProjectIds;
    }
    return unpinnedProjectIds.filter((projectId) => {
      const project = projectById.get(projectId);
      if (!project) {
        return false;
      }
      if (
        project.name.toLowerCase().includes(normalizedProjectSearchQuery) ||
        project.cwd.toLowerCase().includes(normalizedProjectSearchQuery)
      ) {
        return true;
      }
      const projectThreads =
        visibleProjectThreadsByProjectId.get(projectId) ?? EMPTY_SIDEBAR_THREADS;
      return projectThreads.some((thread) =>
        thread.title.toLowerCase().includes(normalizedProjectSearchQuery),
      );
    });
  })();
  const localProjectThreadGroupById = new Map<ProjectId, SidebarLocalProjectThreadGroup>();
  for (const projectId of sortedLocalProjectIds) {
    localProjectThreadGroupById.set(
      projectId,
      deriveSidebarLocalProjectThreadGroup({
        activeThreadId,
        projectExpanded: projectExpandedById[projectId] ?? true,
        projectListThreads: projectListThreadsByProjectId.get(projectId) ?? EMPTY_SIDEBAR_THREADS,
        revealStep: THREAD_REVEAL_STEP,
        unsortedProjectThreads:
          visibleProjectThreadsByProjectId.get(projectId) ?? EMPTY_SIDEBAR_THREADS,
        visibleThreadCount: threadRevealCountByProject[projectId] ?? THREAD_REVEAL_STEP,
        threadSortOrder: sidebarThreadSortOrder,
      }),
    );
  }
  const localProjectThreadGroups = filteredLocalProjectIds.flatMap((projectId) => {
    const threadGroup = localProjectThreadGroupById.get(projectId);
    return threadGroup ? [threadGroup] : [];
  });
  const getSortedActiveThreads = useStableCallback(deriveCurrentSortedActiveThreads);
  const activeSidebarThreadCount = Object.values(sidebarThreadsById).reduce(
    (count, thread) => count + (thread !== undefined && thread.archivedAt === null ? 1 : 0),
    0,
  );
  const renderedPinnedItems = pinnedItems.flatMap<
    { kind: "project"; projectId: ProjectId } | { kind: "thread"; threadId: ThreadId }
  >((item) => {
    if (item.kind === "project") {
      return projectById.has(item.id) ? [{ kind: "project" as const, projectId: item.id }] : [];
    }
    const thread = sidebarThreadsById[item.id];
    if (!thread || thread.archivedAt !== null || !projectById.has(thread.projectId)) {
      return [];
    }
    return [{ kind: "thread" as const, threadId: item.id }];
  });
  const sortedRenderedPinnedItems = [
    ...renderedPinnedItems.filter((item) => item.kind === "thread"),
    ...renderedPinnedItems.filter((item) => item.kind === "project"),
  ];
  const renderedPinnedThreadIds = sortedRenderedPinnedItems.flatMap((item) =>
    item.kind === "thread" ? [item.threadId] : [],
  );
  const remoteSidebarHostSearchMatcher = createContainsMatcher(normalizedProjectSearchQuery);
  const filteredRemoteSidebarHosts = (() => {
    const visibleRemoteSidebarHosts = remoteSidebarHosts.filter(
      (entry) => !isHostConnectionActive(entry.host, activeWsUrl),
    );
    if (normalizedProjectSearchQuery.length === 0) {
      return visibleRemoteSidebarHosts;
    }
    const nextEntries: RemoteSidebarHostEntry[] = [];
    for (const entry of visibleRemoteSidebarHosts) {
      const connectionDescriptor = describeHostConnection(entry.host);
      const containsQuery = (value: string): boolean =>
        remoteSidebarHostSearchMatcher?.test(value) ?? false;
      const hostMatches =
        containsQuery(entry.host.name) ||
        connectionDescriptor.selectorValues.some((value) => containsQuery(value));
      const filteredProjects: RemoteSidebarProjectEntry[] = [];
      for (const project of entry.projects) {
        if (
          containsQuery(project.name) ||
          containsQuery(project.cwd) ||
          project.threads.some((thread) => containsQuery(thread.title))
        ) {
          filteredProjects.push(project);
        }
      }
      if (!hostMatches && filteredProjects.length === 0) {
        continue;
      }
      const projects = hostMatches ? entry.projects : filteredProjects;
      nextEntries.push({
        host: entry.host,
        connectionUrl: entry.connectionUrl,
        status: entry.status,
        projects,
        ...(entry.error ? { error: entry.error } : {}),
      });
    }
    return nextEntries;
  })();
  const renderedRemoteProjects = (() => {
    const nextRenderedRemoteProjects: Array<{
      project: RemoteSidebarProjectEntry;
      projectKey: string;
      connectionUrl: string;
      projectExpanded: boolean;
      visibleThreads: RemoteSidebarThreadEntry[];
      hiddenThreadCount: number;
      hasHiddenThreads: boolean;
      canCollapseThreadList: boolean;
    }> = [];
    for (const entry of filteredRemoteSidebarHosts) {
      if (entry.status !== "available") {
        continue;
      }
      for (const project of entry.projects) {
        const projectKey = remoteProjectKey(entry.connectionUrl, project.id);
        const projectExpanded = remoteProjectExpandedById[projectKey] ?? true;
        const visibleThreadCount =
          remoteThreadRevealCountByProject[projectKey] ?? THREAD_REVEAL_STEP;
        const sortedThreads = sortByUpdatedAtDescending(project.threads);
        const activeThreadIdForConnection = connectionUrlsEqual(
          activeRouteConnectionUrl,
          entry.connectionUrl,
        )
          ? activeThreadId
          : undefined;
        const {
          hasHiddenThreads,
          hiddenThreads,
          visibleThreads: previewThreads,
        } = projectExpanded
          ? getVisibleRemoteThreadsForProject({
              threads: sortedThreads,
              activeThreadId: activeThreadIdForConnection,
              visibleCount: visibleThreadCount,
            })
          : {
              hasHiddenThreads: false,
              hiddenThreads: [],
              visibleThreads: [],
            };
        nextRenderedRemoteProjects.push({
          project,
          projectKey,
          connectionUrl: entry.connectionUrl,
          projectExpanded,
          visibleThreads: previewThreads,
          hiddenThreadCount: hiddenThreads.length,
          hasHiddenThreads,
          canCollapseThreadList: visibleThreadCount > THREAD_REVEAL_STEP,
        });
      }
    }
    return nextRenderedRemoteProjects;
  })();
  useEffect(() => {
    setThreadRevealCountByProject((current) => {
      if (Object.keys(current).length === 0) {
        return current;
      }

      let changed = false;
      const next: Partial<Record<ProjectId, number>> = {};

      for (const project of activeProjects) {
        const configuredCount = current[project.id];
        if (configuredCount === undefined) {
          continue;
        }
        const projectThreadCount = (
          projectListThreadsByProjectId.get(project.id) ?? EMPTY_SIDEBAR_THREADS
        ).length;
        const clampedCount = Math.max(
          THREAD_REVEAL_STEP,
          Math.min(configuredCount, projectThreadCount),
        );
        if (clampedCount > THREAD_REVEAL_STEP) {
          next[project.id] = clampedCount;
        }
        if (clampedCount !== configuredCount || clampedCount === THREAD_REVEAL_STEP) {
          changed = true;
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(current).length) {
        return current;
      }
      return next;
    });
  }, [activeProjects, projectListThreadsByProjectId, setThreadRevealCountByProject]);
  useEffect(() => {
    setRemoteThreadRevealCountByProject((current) => {
      if (Object.keys(current).length === 0) {
        return current;
      }

      const threadCountByProjectKey = new Map<string, number>();
      for (const entry of remoteSidebarHosts) {
        if (entry.status !== "available") {
          continue;
        }
        for (const project of entry.projects) {
          threadCountByProjectKey.set(
            remoteProjectKey(entry.connectionUrl, project.id),
            project.threads.length,
          );
        }
      }

      let changed = false;
      const next: Record<string, number> = {};
      for (const [projectKey, configuredCount] of Object.entries(current)) {
        const projectThreadCount = threadCountByProjectKey.get(projectKey);
        if (projectThreadCount === undefined) {
          changed = true;
          continue;
        }
        const clampedCount = Math.max(
          THREAD_REVEAL_STEP,
          Math.min(configuredCount, projectThreadCount),
        );
        if (clampedCount > THREAD_REVEAL_STEP) {
          next[projectKey] = clampedCount;
        }
        if (clampedCount !== configuredCount || clampedCount === THREAD_REVEAL_STEP) {
          changed = true;
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(current).length) {
        return current;
      }
      return next;
    });
  }, [remoteSidebarHosts, setRemoteThreadRevealCountByProject]);
  const unifiedRenderedProjects = (() => {
    const localProjects = filteredLocalProjectIds.flatMap((projectId) => {
      const project = projectById.get(projectId);
      if (!project) {
        return [];
      }
      return [
        {
          kind: "local" as const,
          key: `local:${project.id}`,
          timestamp: getProjectSortTimestamp(
            project,
            visibleProjectThreadsByProjectId.get(project.id) ?? EMPTY_SIDEBAR_THREADS,
            sidebarProjectSortOrder === "created_at" ? "created_at" : "updated_at",
          ),
          projectName: project.name,
          projectId: project.id,
          payload: project.id,
        },
      ];
    });
    const remoteProjects = renderedRemoteProjects.map((project) => {
      const timestamp =
        sidebarProjectSortOrder === "created_at"
          ? resolveIsoTimestamp(project.project.createdAt)
          : Math.max(
              project.project.threads.reduce(
                (latest, thread) => Math.max(latest, resolveIsoTimestamp(thread.updatedAt)),
                Number.NEGATIVE_INFINITY,
              ),
              resolveIsoTimestamp(project.project.updatedAt),
            );
      return {
        kind: "remote" as const,
        key: `remote:${project.projectKey}`,
        timestamp,
        projectName: project.project.name,
        projectId: project.project.id,
        payload: project,
      };
    });
    return [...localProjects, ...remoteProjects].toSorted((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      const byName = left.projectName.localeCompare(right.projectName);
      if (byName !== 0) {
        return byName;
      }
      return left.projectId.localeCompare(right.projectId);
    });
  })();
  const sidebarProjectListItems: SidebarProjectListItem[] = (() => {
    if (isProjectDraggingEnabled) {
      return [
        ...filteredLocalProjectIds.map((projectId) => {
          const threadGroup = localProjectThreadGroupById.get(projectId);
          return {
            kind: "local" as const,
            key: `local:${projectId}`,
            projectId,
            renderedThreadCount: threadGroup?.renderedThreadIds.length ?? 0,
            auxiliaryRowCount:
              (threadGroup?.showEmptyThreadState ? 1 : 0) +
              (threadGroup?.hasHiddenThreads ? 1 : 0) +
              (threadGroup?.canCollapseThreadList ? 1 : 0),
            sortable: true,
          };
        }),
        ...renderedRemoteProjects.map((renderedProject) => ({
          kind: "remote" as const,
          key: `remote:${renderedProject.projectKey}`,
          renderedProject,
        })),
      ];
    }

    return unifiedRenderedProjects.map((renderedProject) => {
      if (renderedProject.kind === "local") {
        const threadGroup = localProjectThreadGroupById.get(renderedProject.payload);
        return {
          kind: "local" as const,
          key: renderedProject.key,
          projectId: renderedProject.payload,
          renderedThreadCount: threadGroup?.renderedThreadIds.length ?? 0,
          auxiliaryRowCount:
            (threadGroup?.showEmptyThreadState ? 1 : 0) +
            (threadGroup?.hasHiddenThreads ? 1 : 0) +
            (threadGroup?.canCollapseThreadList ? 1 : 0),
          sortable: false,
        };
      }
      return {
        kind: "remote" as const,
        key: renderedProject.key,
        renderedProject: renderedProject.payload,
      };
    });
  })();
  const sidebarProjectListLayoutSignature = sidebarProjectListItems
    .map(getSidebarProjectListItemLayoutSignature)
    .join("|");
  const sidebarProjectListMeasureKey = [
    boardsSectionExpanded ? 1 : 0,
    pinnedSectionExpanded ? 1 : 0,
    projectsSectionExpanded,
    savedBoards.length,
    shouldShowProjectPathEntry ? 1 : 0,
    sortedRenderedPinnedItems.length,
    visibleSavedBoardItems.length,
  ].join("|");

  const hasExpandedVisibleProjects =
    filteredLocalProjectIds.some((projectId) => {
      const threadGroup = localProjectThreadGroupById.get(projectId);
      return threadGroup?.projectExpanded && threadGroup.renderedThreadIds.length > 0;
    }) ||
    renderedRemoteProjects.some(
      (renderedProject) =>
        renderedProject.projectExpanded && renderedProject.visibleThreads.length > 0,
    );
  const canCollapseVisibleProjects = projectsSectionExpanded && hasExpandedVisibleProjects;
  const collapseVisibleProjects = () => {
    for (const projectId of filteredLocalProjectIds) {
      const threadGroup = localProjectThreadGroupById.get(projectId);
      if (threadGroup?.projectExpanded && threadGroup.renderedThreadIds.length > 0) {
        setProjectExpanded(projectId, false);
      }
    }
    setRemoteProjectExpandedById((current) => {
      let changed = false;
      const next = { ...current };
      for (const renderedProject of renderedRemoteProjects) {
        if (!renderedProject.projectExpanded || renderedProject.visibleThreads.length === 0) {
          continue;
        }
        if (next[renderedProject.projectKey] !== false) {
          next[renderedProject.projectKey] = false;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  };
  const sortedActiveThreadsForSplitPicker = splitPickerOpen ? getSortedActiveThreads() : [];
  const splitPickerAvailableThreadCount = splitPickerOpen
    ? sortedActiveThreadsForSplitPicker.length
    : activeSidebarThreadCount;
  const splitPickerThreadOptions = (() => {
    if (!splitPickerOpen) {
      return [];
    }
    return sortedActiveThreadsForSplitPicker.map((thread) => ({
      activityAt: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
      connectionUrl: resolveConnectionForThreadId(thread.id) ?? null,
      id: thread.id,
      projectId: thread.projectId,
      projectName: projectById.get(thread.projectId)?.name ?? "Unknown project",
      title: thread.title.trim() || "Untitled thread",
      updatedAt: Math.max(
        resolveIsoTimestamp(thread.latestUserMessageAt ?? undefined),
        resolveIsoTimestamp(thread.updatedAt),
        resolveIsoTimestamp(thread.createdAt),
      ),
    }));
  })();
  const splitPickerProjectFilterOptions = (() => {
    const projectOptions = new Map<string, string>();
    for (const thread of splitPickerThreadOptions) {
      projectOptions.set(thread.projectId, thread.projectName);
    }
    return [...projectOptions.entries()]
      .map(([projectId, projectName]) => ({ projectId, projectName }))
      .toSorted((left, right) => left.projectName.localeCompare(right.projectName));
  })();
  const normalizedSplitPickerQuery = splitPickerQuery.trim().toLowerCase();
  const visibleSplitPickerThreadOptions = (() => {
    const filteredThreads = splitPickerThreadOptions.filter((thread) => {
      if (splitPickerProjectFilter !== "all" && thread.projectId !== splitPickerProjectFilter) {
        return false;
      }
      if (!normalizedSplitPickerQuery) {
        return true;
      }
      return (
        thread.title.toLowerCase().includes(normalizedSplitPickerQuery) ||
        thread.projectName.toLowerCase().includes(normalizedSplitPickerQuery)
      );
    });
    return filteredThreads.toSorted((left, right) => {
      if (splitPickerSortOrder === "title") {
        return (
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
          right.updatedAt - left.updatedAt
        );
      }
      if (splitPickerSortOrder === "project") {
        return (
          left.projectName.localeCompare(right.projectName, undefined, { sensitivity: "base" }) ||
          left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
        );
      }
      return right.updatedAt - left.updatedAt;
    });
  })();
  const selectedSplitThreadCount = splitPickerSelectedThreadIds.size;
  const openSplitPicker = () => {
    dispatchSidebarSplitBoardUiState({ type: "open-split-picker" });
  };
  const toggleSplitPickerThread = (threadId: ThreadId) => {
    dispatchSidebarSplitBoardUiState({ type: "toggle-split-picker-thread", threadId });
  };
  const createSelectedSplit = () => {
    const selectedTargets: Array<{
      connectionUrl: string | null;
      threadId: ThreadId;
      title: string | null;
    }> = [];
    for (const thread of splitPickerThreadOptions) {
      if (splitPickerSelectedThreadIds.has(thread.id)) {
        selectedTargets.push({
          connectionUrl: thread.connectionUrl,
          threadId: thread.id,
          title: thread.title ?? null,
        });
      }
    }
    if (selectedTargets.length < 2) {
      return;
    }
    for (const target of selectedTargets) {
      if (target.connectionUrl) {
        useHostConnectionStore
          .getState()
          .upsertThreadOwnership(target.connectionUrl, target.threadId);
      }
    }
    const activeTarget = selectedTargets[selectedTargets.length - 1]!;
    const splitId = useChatThreadBoardStore.getState().createSplit({
      activeThread: activeTarget,
      threads: selectedTargets,
      title: buildSplitTitle(selectedTargets),
    });
    if (!splitId) {
      return;
    }
    dispatchSidebarSplitBoardUiState({ type: "close-split-picker" });
    navigateToBoardThreadRoute(activeTarget);
  };
  const sidebarNewThreadProjectId =
    defaultProjectId && projectById.has(defaultProjectId) ? defaultProjectId : null;
  const handleStartNewThreadForProject = (projectId: ProjectId) => {
    void handleNewThread(
      projectId,
      resolveSidebarNewThreadOptions({
        projectId,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          activeThread && activeThread.projectId === projectId
            ? {
                projectId: activeThread.projectId,
                branch: activeThread.branch,
                worktreePath: activeThread.worktreePath,
              }
            : null,
        activeDraftThread:
          activeDraftThread && activeDraftThread.projectId === projectId
            ? {
                projectId: activeDraftThread.projectId,
                branch: activeDraftThread.branch,
                worktreePath: activeDraftThread.worktreePath,
                envMode: activeDraftThread.envMode,
              }
            : null,
      }),
    );
  };
  const handleStartSidebarNewChat = () => {
    if (!sidebarNewThreadProjectId) {
      return;
    }
    handleStartNewThreadForProject(sidebarNewThreadProjectId);
  };

  const handleStartNewThreadForRemoteProject = (input: {
    connectionUrl: string;
    project: RemoteSidebarProjectEntry;
  }) => {
    void handleNewThread(input.project.id, {
      ...resolveSidebarNewThreadOptions({
        projectId: input.project.id,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          activeThread && activeThread.projectId === input.project.id
            ? {
                projectId: activeThread.projectId,
                branch: activeThread.branch,
                worktreePath: activeThread.worktreePath,
              }
            : null,
        activeDraftThread:
          activeDraftThread && activeDraftThread.projectId === input.project.id
            ? {
                projectId: activeDraftThread.projectId,
                branch: activeDraftThread.branch,
                worktreePath: activeDraftThread.worktreePath,
                envMode: activeDraftThread.envMode,
              }
            : null,
      }),
      connectionUrl: input.connectionUrl,
    });
  };
  const {
    searchPaletteOpen,
    searchPaletteMode,
    searchPaletteQuery,
    searchPaletteActiveIndex,
    searchPaletteKeyboardNavigationId,
    searchPaletteInputRef,
    normalizedSearchPaletteQuery,
    searchPaletteItems,
    searchPaletteActionItems,
    searchPaletteProjectItems,
    searchPaletteThreadItems,
    searchPaletteIndexById,
    openSearchPalette,
    closeSearchPalette,
    handleSearchPaletteOpenChange,
    handleSearchPaletteBack,
    handleSearchPaletteQueryChange,
    handleSearchPaletteItemHover,
    handleSearchPaletteInputKeyDown,
    handleSearchPaletteSelect,
  } = useSidebarCommandPalette({
    sortedProjects,
    visibleProjectThreadsByProjectId,
    remoteSidebarHosts,
    getSortedActiveThreads,
    projectById,
    activeWsUrl,
    localDeviceConnectionUrl,
    projectSortOrder: sidebarProjectSortOrder,
    threadSortOrder: sidebarThreadSortOrder,
    onStartAddProject: handleStartAddProject,
    onStartNewThreadForProject: handleStartNewThreadForProject,
    onStartNewThreadForRemoteProject: (input) => {
      void handleStartNewThreadForRemoteProject(input);
    },
    onFocusMostRecentThreadForProject: focusMostRecentThreadForProject,
    onNavigateSettings: () => {
      void navigate({ to: "/settings" });
    },
    onNavigateTerminals: () => {
      void navigate({ to: "/terminals" });
    },
    onNavigateToThread: navigateToThread,
    onNavigateToThreadOnConnection: navigateToThreadOnConnection,
  });

  const pinnedRenderedThreadGroups: Array<
    | { kind: "thread"; threadId: ThreadId }
    | { kind: "project"; renderedProject: SidebarLocalProjectThreadGroup }
  > = (() => {
    const next: Array<
      | { kind: "thread"; threadId: ThreadId }
      | { kind: "project"; renderedProject: SidebarLocalProjectThreadGroup }
    > = [];
    for (const item of sortedRenderedPinnedItems) {
      if (item.kind === "thread") {
        next.push(item);
        continue;
      }
      const threadGroup = localProjectThreadGroupById.get(item.projectId);
      if (threadGroup) {
        next.push({ kind: "project", renderedProject: threadGroup });
      }
    }
    return next;
  })();
  const renderedSidebarThreadGroups = buildRenderedSidebarThreadGroups<
    ThreadId,
    SidebarLocalProjectThreadGroup
  >({
    pinnedItems: pinnedRenderedThreadGroups,
    renderedProjects: localProjectThreadGroups,
    pinnedSectionExpanded,
  });
  const { visibleSidebarThreadIds, prByThreadId } = useSidebarThreadPrStatus({
    renderedProjects: renderedSidebarThreadGroups,
    readThreadSummary: readSidebarThreadSummary,
    projectCwdById,
  });
  const threadJumpCommandById = (() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  })();
  const threadJumpLabelById = (() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  })();
  const orderedSidebarThreadIds = visibleSidebarThreadIds;

  useEffect(() => {
    const nearbyThreadIds = resolveNearbyThreadIds({
      threadIds: orderedSidebarThreadIds,
      currentThreadId: routeThreadId,
      limit: SIDEBAR_THREAD_PREFETCH_WINDOW,
    });
    if (nearbyThreadIds.length === 0) {
      return;
    }

    let cancelled = false;
    const cancelScheduledPrefetch = scheduleSidebarSpeculativePrefetch(() => {
      void mapWithConcurrencyLimit(
        nearbyThreadIds,
        SIDEBAR_THREAD_PREFETCH_CONCURRENCY,
        async (nearbyThreadId, index) => {
          if (cancelled) {
            return;
          }
          const shouldHydrateStore = index < SIDEBAR_THREAD_PREFETCH_STORE_HYDRATE_COUNT;
          await prefetchThreadHistory(nearbyThreadId, {
            hydrateStore: shouldHydrateStore,
            prewarmRows: true,
            priority: shouldHydrateStore ? "immediate" : "background",
          });
        },
      );
    });

    return () => {
      cancelled = true;
      cancelScheduledPrefetch();
    };
  }, [orderedSidebarThreadIds, prefetchThreadHistory, routeThreadId]);

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      if (command === "search.open") {
        if (isEditableHotkeyTarget(event.target) || isOnSettings) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (searchPaletteOpen) {
          closeSearchPalette();
          return;
        }
        openSearchPalette();
        return;
      }
      if (command === "project.add") {
        if (isEditableHotkeyTarget(event.target) || isOnSettings) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        handleStartAddProjectEffect();
        return;
      }
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadId = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadIds,
          currentThreadId: routeThreadId,
          direction: traversalDirection,
        });
        if (!targetThreadId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThreadEffect(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = visibleSidebarThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThreadEffect(targetThreadId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateThreadJumpHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    keybindings,
    closeSearchPalette,
    isOnSettings,
    openSearchPalette,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    searchPaletteOpen,
    visibleSidebarThreadIds,
    updateThreadJumpHintsVisibility,
  ]);

  function renderPinnedThreadRow(threadId: ThreadId) {
    const boardDrag = createBoardThreadRowDragProps({
      connectionUrl: activeWsUrl,
      threadId,
    });
    return (
      <SidebarThreadRow
        key={threadId}
        threadId={threadId}
        orderedProjectThreadIds={renderedPinnedThreadIds}
        routeThreadId={activeSidebarRouteThreadId}
        activeRouteConnectionUrl={activeRouteConnectionUrl}
        connectionUrl={activeWsUrl}
        selectedThreadIds={selectedThreadIds}
        showThreadJumpHints={showThreadJumpHints}
        jumpLabel={threadJumpLabelById.get(threadId) ?? null}
        appSettingsConfirmThreadArchive={confirmThreadArchive}
        isPinned
        boardDrag={boardDrag}
        showPinnedIndicator={false}
        renamingThreadId={null}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadId={confirmingArchiveThreadId}
        setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        prefetchThreadHistory={prefetchThreadHistory}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        onTogglePinnedThread={togglePinnedThread}
        openPrLink={openPrLink}
        pr={prByThreadId.get(threadId) ?? null}
      />
    );
  }

  const markProjectContextMenuPending = () => {
    suppressProjectClickForContextMenuRef.current = true;
  };

  const sidebarRemoteProjectThreadRowSharedProps = {
    appSettingsConfirmThreadArchive: confirmThreadArchive,
    isPinned: false,
    pinEnabled: false,
    renamingThreadId: null,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadId,
    setConfirmingArchiveThreadId,
    confirmArchiveButtonRefs,
    handleThreadClick,
    prefetchThreadHistory,
    handleMultiSelectContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    onTogglePinnedThread: togglePinnedThread,
    openPrLink,
    selectedThreadIds,
    showThreadJumpHints,
  };
  const getRemoteThreadPr = (threadId: ThreadId) => prByThreadId.get(threadId) ?? null;

  function renderVirtualProjectListItem({
    item,
    measureElement,
    virtualRow,
    virtualStyle,
  }: SidebarProjectListRenderItemArgs) {
    if (item.kind === "local") {
      if (item.sortable) {
        return (
          <SortableProjectItem
            key={item.key}
            projectId={item.projectId}
            measureElement={measureElement}
            style={virtualStyle}
            virtualIndex={virtualRow.index}
          >
            {(dragHandleProps) => (
              <SidebarLocalProjectItem
                activeRouteConnectionUrl={activeRouteConnectionUrl}
                activeSidebarRouteThreadId={activeSidebarRouteThreadId}
                appSettingsConfirmThreadArchive={confirmThreadArchive}
                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                confirmingArchiveThreadId={confirmingArchiveThreadId}
                connectionUrl={activeWsUrl}
                createBoardThreadRowDragProps={createBoardThreadRowDragProps}
                dragHandleProps={dragHandleProps}
                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                handleProjectContextMenu={handleProjectContextMenu}
                handleProjectTitleClick={handleProjectTitleClick}
                handleProjectTitleKeyDown={handleProjectTitleKeyDown}
                handleProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
                handleStartNewThreadForProject={handleStartNewThreadForProject}
                handleThreadClick={handleThreadClick}
                handleThreadContextMenu={handleThreadContextMenu}
                isPinned={pinnedProjectIdSet.has(item.projectId)}
                jumpLabelByThreadId={threadJumpLabelById}
                markProjectContextMenuPending={markProjectContextMenuPending}
                newThreadShortcutLabel={newThreadShortcutLabel}
                onCollapseThreadList={collapseThreadListForProject}
                onExpandThreadList={expandThreadListForProject}
                onTogglePinnedProject={togglePinnedProject}
                onTogglePinnedThread={togglePinnedThread}
                openPrLink={openPrLink}
                pinnedThreadIdSet={pinnedThreadIdSet}
                prByThreadId={prByThreadId}
                prefetchThreadHistory={prefetchThreadHistory}
                projectId={item.projectId}
                renamingCommittedRef={renamingCommittedRef}
                renamingInputRef={renamingInputRef}
                renamingThreadId={null}
                renamingTitle={renamingTitle}
                routeThreadId={activeSidebarRouteThreadId}
                selectedThreadIds={selectedThreadIds}
                setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
                setRenamingTitle={setRenamingTitle}
                showThreadJumpHints={showThreadJumpHints}
                threadRevealCount={threadRevealCountByProject[item.projectId] ?? THREAD_REVEAL_STEP}
                threadSortOrder={sidebarThreadSortOrder}
                clearSelection={clearSelection}
                commitRename={commitRename}
                cancelRename={cancelRename}
                attemptArchiveThread={attemptArchiveThread}
                navigateToThread={navigateToThread}
              />
            )}
          </SortableProjectItem>
        );
      }
      return (
        <SidebarMenuItem
          key={item.key}
          ref={measureElement}
          className="rounded-md"
          data-index={virtualRow.index}
          style={virtualStyle}
        >
          <SidebarLocalProjectItem
            activeRouteConnectionUrl={activeRouteConnectionUrl}
            activeSidebarRouteThreadId={activeSidebarRouteThreadId}
            appSettingsConfirmThreadArchive={confirmThreadArchive}
            confirmArchiveButtonRefs={confirmArchiveButtonRefs}
            confirmingArchiveThreadId={confirmingArchiveThreadId}
            connectionUrl={activeWsUrl}
            createBoardThreadRowDragProps={createBoardThreadRowDragProps}
            dragHandleProps={null}
            handleMultiSelectContextMenu={handleMultiSelectContextMenu}
            handleProjectContextMenu={handleProjectContextMenu}
            handleProjectTitleClick={handleProjectTitleClick}
            handleProjectTitleKeyDown={handleProjectTitleKeyDown}
            handleProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
            handleStartNewThreadForProject={handleStartNewThreadForProject}
            handleThreadClick={handleThreadClick}
            handleThreadContextMenu={handleThreadContextMenu}
            isPinned={pinnedProjectIdSet.has(item.projectId)}
            jumpLabelByThreadId={threadJumpLabelById}
            markProjectContextMenuPending={markProjectContextMenuPending}
            newThreadShortcutLabel={newThreadShortcutLabel}
            onCollapseThreadList={collapseThreadListForProject}
            onExpandThreadList={expandThreadListForProject}
            onTogglePinnedProject={togglePinnedProject}
            onTogglePinnedThread={togglePinnedThread}
            openPrLink={openPrLink}
            pinnedThreadIdSet={pinnedThreadIdSet}
            prByThreadId={prByThreadId}
            prefetchThreadHistory={prefetchThreadHistory}
            projectId={item.projectId}
            renamingCommittedRef={renamingCommittedRef}
            renamingInputRef={renamingInputRef}
            renamingThreadId={null}
            renamingTitle={renamingTitle}
            routeThreadId={activeSidebarRouteThreadId}
            selectedThreadIds={selectedThreadIds}
            setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
            setRenamingTitle={setRenamingTitle}
            showThreadJumpHints={showThreadJumpHints}
            threadRevealCount={threadRevealCountByProject[item.projectId] ?? THREAD_REVEAL_STEP}
            threadSortOrder={sidebarThreadSortOrder}
            clearSelection={clearSelection}
            commitRename={commitRename}
            cancelRename={cancelRename}
            attemptArchiveThread={attemptArchiveThread}
            navigateToThread={navigateToThread}
          />
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem
        key={item.key}
        ref={measureElement}
        className="rounded-md"
        data-index={virtualRow.index}
        style={virtualStyle}
      >
        <SidebarRemoteProjectItem
          activeRouteConnectionUrl={activeRouteConnectionUrl}
          createBoardThreadRowDragProps={createBoardThreadRowDragProps}
          expandThreadListForRemoteProject={expandThreadListForRemoteProject}
          collapseThreadListForRemoteProject={collapseThreadListForRemoteProject}
          getThreadPr={getRemoteThreadPr}
          handleRemoteProjectContextMenu={handleRemoteProjectContextMenu}
          handleRemoteThreadContextMenu={handleRemoteThreadContextMenu}
          handleStartNewThreadForRemoteProject={handleStartNewThreadForRemoteProject}
          navigateToThreadOnConnection={navigateToThreadOnConnection}
          newThreadShortcutLabel={newThreadShortcutLabel}
          renderedProject={item.renderedProject}
          routeThreadId={activeSidebarRouteThreadId}
          showThreadJumpHints={showThreadJumpHints}
          threadRowSharedProps={sidebarRemoteProjectThreadRowSharedProps}
          toggleRemoteProject={toggleRemoteProject}
        />
      </SidebarMenuItem>
    );
  }

  const handleProjectTitleClick = (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
    if (suppressProjectClickForContextMenuRef.current) {
      suppressProjectClickForContextMenuRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (dragInProgressRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (suppressProjectClickAfterDragRef.current) {
      // Consume the synthetic click emitted after a drag release.
      suppressProjectClickAfterDragRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (selectedThreadIds.size > 0) {
      clearSelection();
    }
    startTransition(() => {
      toggleProject(projectId);
    });
  };

  const handleProjectTitleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (dragInProgressRef.current) {
      return;
    }
    startTransition(() => {
      toggleProject(projectId);
    });
  };

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch((error) => {
        reportBackgroundError("Failed to read the desktop update state.", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [setThreadRevealCountByProject]);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);
  const searchShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "search.open",
    sidebarShortcutLabelOptions,
  );
  const addProjectShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "project.add",
    sidebarShortcutLabelOptions,
  );
  const navigationBackShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "navigation.back",
    sidebarShortcutLabelOptions,
  );
  const navigationForwardShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "navigation.forward",
    sidebarShortcutLabelOptions,
  );
  const sidebarToggleShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "sidebar.toggle",
    sidebarShortcutLabelOptions,
  );

  // Auto-scroll search palette list only when navigating with keyboard.
  useEffect(() => {
    const listElement = searchPaletteListRef.current;
    if (!listElement || searchPaletteActiveIndex < 0 || searchPaletteKeyboardNavigationId === 0) {
      return;
    }

    const activeItem = listElement.querySelector<HTMLElement>(
      `[data-search-palette-index="${String(searchPaletteActiveIndex)}"]`,
    );
    if (!activeItem) {
      return;
    }

    activeItem.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [searchPaletteActiveIndex, searchPaletteKeyboardNavigationId]);

  const handleDesktopUpdateButtonClick = () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const api = readNativeApi() ?? ensureNativeApi();
      void (async () => {
        const confirmed = await api.dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
        );
        if (!confirmed) return;
        const result = await bridge.installUpdate();
        if (!shouldToastDesktopUpdateActionResult(result)) return;
        const actionError = getDesktopUpdateActionError(result);
        if (!actionError) return;
        toastManager.add({
          type: "error",
          title: "Could not install update",
          description: actionError,
        });
      })().catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not install update",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
    }
  };

  const expandThreadListForProject = (projectId: ProjectId) => {
    setThreadRevealCountByProject((current) => {
      const nextCount = (current[projectId] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
      return {
        ...current,
        [projectId]: nextCount,
      };
    });
  };

  const collapseThreadListForProject = (projectId: ProjectId) => {
    setThreadRevealCountByProject((current) => {
      if (current[projectId] === undefined) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  };

  const toggleRemoteProject = (projectKey: string) => {
    setRemoteProjectExpandedById((current) => ({
      ...current,
      [projectKey]: !(current[projectKey] ?? true),
    }));
  };

  const expandThreadListForRemoteProject = (projectKey: string) => {
    setRemoteThreadRevealCountByProject((current) => {
      const nextCount = (current[projectKey] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
      return {
        ...current,
        [projectKey]: nextCount,
      };
    });
  };

  const collapseThreadListForRemoteProject = (projectKey: string) => {
    setRemoteThreadRevealCountByProject((current) => {
      if (current[projectKey] === undefined) return current;
      const next = { ...current };
      delete next[projectKey];
      return next;
    });
  };

  const sidebarHeaderToggle = showSidebarHeaderToggle ? (
    <Tooltip>
      <TooltipTrigger
        render={<SidebarTrigger className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME} />}
      />
      <TooltipPopup side="bottom" sideOffset={4}>
        <SidebarHeaderTooltipContent
          label="Toggle sidebar"
          shortcutLabel={sidebarToggleShortcutLabel}
        />
      </TooltipPopup>
    </Tooltip>
  ) : null;
  const sidebarHeaderNavIconClassName =
    "size-[19px] opacity-72 transition-opacity duration-150 group-hover/sidebar-nav-button:opacity-100";
  const sidebarHeaderChrome = (
    <div
      ref={sidebarHeaderRowRef}
      className="grid h-8 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2"
    >
      <div className={DESKTOP_HEADER_NAV_CLUSTER_CLASS_NAME}>
        {sidebarHeaderToggle}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME}
                aria-label="Go back"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className={sidebarHeaderNavIconClassName} strokeWidth={2.25} />
              </Button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            <SidebarHeaderTooltipContent label="Back" shortcutLabel={navigationBackShortcutLabel} />
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME}
                aria-label="Go forward"
                onClick={() => window.history.forward()}
              >
                <ArrowRightIcon className={sidebarHeaderNavIconClassName} strokeWidth={2.25} />
              </Button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            <SidebarHeaderTooltipContent
              label="Forward"
              shortcutLabel={navigationForwardShortcutLabel}
            />
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="min-w-0" />
      <div className="shrink-0" />
    </div>
  );
  const shouldUseDesktopHeaderChrome =
    isElectron && typeof window !== "undefined" && window.desktopBridge !== undefined;

  return (
    <>
      <Dialog
        open={projectEditorOpen && editingProjectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectEditor();
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>Update the project's name and icon.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {editingProjectTarget ? (
              <form
                id="sidebar-project-editor-form"
                className="space-y-4"
                onSubmit={(event) => void saveProjectEdits(event)}
              >
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Name</p>
                  <Input
                    value={editingProjectName}
                    onChange={(event) => setEditingProjectName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Icon</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className={`h-10 justify-start gap-2 rounded-md border px-2.5 text-xs focus-visible:border-border/80 focus-visible:ring-border/25 ${
                        editingProjectIcon === null
                          ? "border-border/62 bg-muted/20 text-foreground"
                          : "border-border/24 bg-transparent text-muted-foreground/72 hover:border-border/48 hover:bg-muted/12 hover:text-foreground"
                      }`}
                      onClick={() => setEditingProjectIcon(null)}
                    >
                      <ProjectAvatar
                        project={{
                          cwd: editingProjectTarget.cwd,
                          icon: null,
                        }}
                        className="size-4.5"
                      />
                      <span className="min-w-0 truncate">Favicon</span>
                    </Button>
                    {PROJECT_ICON_OPTIONS.map((option) => {
                      const previewIcon = {
                        glyph: option.glyph,
                        color: editingProjectIcon?.color ?? "slate",
                      } as const;
                      const isSelected = editingProjectIcon?.glyph === option.glyph;
                      const displayIcon = isSelected
                        ? previewIcon
                        : ({ glyph: option.glyph, color: "slate" } as const);
                      return (
                        <Button
                          key={option.glyph}
                          type="button"
                          variant="ghost"
                          className={`h-10 justify-start gap-2 rounded-md border px-2.5 text-xs focus-visible:border-border/80 focus-visible:ring-border/25 ${
                            isSelected
                              ? "border-border/62 bg-muted/20 text-foreground"
                              : "border-border/24 bg-transparent text-muted-foreground/72 hover:border-border/48 hover:bg-muted/12 hover:text-foreground"
                          }`}
                          onClick={() => setEditingProjectIcon(previewIcon)}
                        >
                          <ProjectGlyphIcon icon={displayIcon} className="size-4.5" />
                          <span className="min-w-0 truncate">{option.label}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
                {editingProjectIcon !== null ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Color</p>
                    <div className="grid grid-cols-3 gap-2">
                      {PROJECT_ICON_COLOR_OPTIONS.map((option) => {
                        const isSelected = editingProjectIcon.color === option.color;
                        return (
                          <Button
                            key={option.color}
                            type="button"
                            variant="ghost"
                            className={`h-8 justify-start gap-2 rounded-md border px-2.5 text-xs focus-visible:border-border/80 focus-visible:ring-border/25 ${
                              isSelected
                                ? "border-border/62 bg-muted/20 text-foreground"
                                : "border-border/24 bg-transparent text-muted-foreground/72 hover:border-border/48 hover:bg-muted/12 hover:text-foreground"
                            }`}
                            onClick={() =>
                              setEditingProjectIcon((current) =>
                                current === null ? current : { ...current, color: option.color },
                              )
                            }
                          >
                            <span className={`size-2.5 rounded-full ${option.swatchClassName}`} />
                            <span className="min-w-0 truncate">{option.label}</span>
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </form>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeProjectEditor}>
              Cancel
            </Button>
            <Button form="sidebar-project-editor-form" type="submit">
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <ThreadRenameDialog
        open={localThreadRenameTarget !== null}
        initialTitle={localThreadRenameTarget?.title ?? renamingTitle}
        description="Update the chat title shown in the sidebar and header."
        onOpenChange={(open) => {
          if (!open) {
            cancelRename();
          }
        }}
        onSubmit={saveLocalThreadRename}
      />
      <ThreadRenameDialog
        open={remoteThreadRenameTarget !== null}
        initialTitle={remoteThreadRenameTarget?.thread.title ?? remoteThreadRenameTitle}
        description={
          remoteThreadRenameTarget
            ? `Update the chat title in ${remoteThreadRenameTarget.project.name}.`
            : "Update the chat title."
        }
        onOpenChange={(open) => {
          if (!open) {
            closeRemoteThreadRenameDialog();
          }
        }}
        onSubmit={saveRemoteThreadRename}
      />
      <SidebarSplitPickerDialog
        open={splitPickerOpen}
        availableThreadCount={splitPickerAvailableThreadCount}
        query={splitPickerQuery}
        projectFilter={splitPickerProjectFilter}
        projectFilterOptions={splitPickerProjectFilterOptions}
        sortOrder={splitPickerSortOrder}
        visibleThreads={visibleSplitPickerThreadOptions}
        selectedThreadIds={splitPickerSelectedThreadIds}
        selectedThreadCount={selectedSplitThreadCount}
        onOpenChange={(open) => {
          if (open) {
            dispatchSidebarSplitBoardUiState({
              type: "set-split-picker-open",
              splitPickerOpen: true,
            });
            return;
          }
          dispatchSidebarSplitBoardUiState({ type: "close-split-picker" });
        }}
        onQueryChange={setSplitPickerQuery}
        onProjectFilterChange={setSplitPickerProjectFilter}
        onSortOrderChange={setSplitPickerSortOrder}
        onToggleThread={toggleSplitPickerThread}
        onCancel={() => {
          dispatchSidebarSplitBoardUiState({ type: "close-split-picker" });
        }}
        onCreate={createSelectedSplit}
      />
      {splitContextMenuState && contextMenuSplit ? (
        <Menu
          key={`${contextMenuSplit.id}:${splitContextMenuState.position.x}:${splitContextMenuState.position.y}`}
          defaultOpen
          modal={false}
          onOpenChange={(open) => {
            if (!open) {
              closeSplitContextMenu();
            }
          }}
        >
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none fixed z-50 size-px opacity-0"
                style={{
                  left: `${splitContextMenuState.position.x}px`,
                  top: `${splitContextMenuState.position.y}px`,
                }}
              />
            }
          />
          <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-48">
            <MenuItem onClick={() => void handleSplitMenuAction(contextMenuSplit, "open")}>
              Open split
            </MenuItem>
            <div className="mx-2 my-1 h-px bg-border" />
            <MenuItem onClick={() => void handleSplitMenuAction(contextMenuSplit, "rename")}>
              Rename split
            </MenuItem>
            <MenuItem onClick={() => void handleSplitMenuAction(contextMenuSplit, "archive")}>
              Archive split
            </MenuItem>
            <MenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => void handleSplitMenuAction(contextMenuSplit, "delete")}
            >
              Delete split
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}

      <SidebarSearchPaletteDialog
        open={searchPaletteOpen}
        mode={searchPaletteMode}
        query={searchPaletteQuery}
        normalizedQuery={normalizedSearchPaletteQuery}
        activeIndex={searchPaletteActiveIndex}
        inputRef={searchPaletteInputRef}
        listRef={searchPaletteListRef}
        items={searchPaletteItems}
        actionItems={searchPaletteActionItems}
        projectItems={searchPaletteProjectItems}
        threadItems={searchPaletteThreadItems}
        indexById={searchPaletteIndexById}
        projectById={projectById}
        onOpenChange={handleSearchPaletteOpenChange}
        onBack={handleSearchPaletteBack}
        onQueryChange={handleSearchPaletteQueryChange}
        onInputKeyDown={handleSearchPaletteInputKeyDown}
        onHoverItem={handleSearchPaletteItemHover}
        onSelectItem={handleSearchPaletteSelect}
      />

      <CommandDialog
        open={shouldShowProjectPathEntry}
        onOpenChange={(open) => {
          dispatchProjectPickerState({ type: "set-adding-project", addingProject: open });
          if (!open) {
            setAddProjectError(null);
            dispatchProjectPickerState({
              type: "set-project-picker-step",
              projectPickerStep: "environment",
            });
            dispatchProjectPickerState({
              type: "set-project-picker-environment-query",
              projectPickerEnvironmentQuery: "",
            });
            dispatchProjectPickerState({
              type: "set-project-picker-selected-connection-url",
              projectPickerSelectedConnectionUrl: null,
            });
            dispatchProjectPickerState({
              type: "set-project-picker-environment-probe-id",
              projectPickerEnvironmentProbeId: null,
            });
          }
        }}
      >
        <CommandDialogPopup className="glass-surface flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border p-0">
          <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3 bg-gradient-to-b from-popover/50 to-popover/20">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                if (projectPickerStep === "environment") {
                  dispatchProjectPickerState({ type: "set-adding-project", addingProject: false });
                  setAddProjectError(null);
                  dispatchProjectPickerState({
                    type: "set-project-picker-environment-probe-id",
                    projectPickerEnvironmentProbeId: null,
                  });
                  return;
                }
                if (pickerEnvironments.length > 1) {
                  dispatchProjectPickerState({
                    type: "set-project-picker-step",
                    projectPickerStep: "environment",
                  });
                  dispatchProjectPickerState({
                    type: "set-project-picker-environment-query",
                    projectPickerEnvironmentQuery: "",
                  });
                  setActiveProjectBrowseIndex(0);
                  return;
                }
                handleBrowseParentPath();
              }}
              disabled={isAddingProject || projectBrowseState.isBrowsing}
              aria-label={
                projectPickerStep === "environment"
                  ? "Close project picker"
                  : pickerEnvironments.length > 1
                    ? "Back to environments"
                    : "Browse parent directory"
              }
            >
              <ChevronLeftIcon className="size-5" strokeWidth={2.5} />
            </Button>
            <input
              ref={addProjectInputRef}
              aria-label={
                projectPickerStep === "environment" ? "Search environments" : "Project path"
              }
              className={`h-9 min-w-0 flex-1 rounded-lg border bg-background/60 px-3 text-sm font-medium text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all ${
                addProjectError
                  ? "border-red-500/50 focus:ring-red-500/20 focus:border-red-500"
                  : "border-border/50"
              }`}
              placeholder={
                projectPickerStep === "environment" ? "Search environments..." : "/path/to/project"
              }
              value={projectPickerStep === "environment" ? projectPickerEnvironmentQuery : newCwd}
              onChange={(event) => {
                if (projectPickerStep === "environment") {
                  dispatchProjectPickerState({
                    type: "set-project-picker-environment-query",
                    projectPickerEnvironmentQuery: event.target.value,
                  });
                } else {
                  dispatchProjectPickerState({
                    type: "set-new-cwd",
                    newCwd: event.target.value,
                  });
                }
                setAddProjectError(null);
              }}
              onKeyDown={handleAddProjectInputKeyDown}
            />
            {projectPickerStep === "directory" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0 justify-end gap-2 px-3 text-foreground/80 hover:bg-accent/60 hover:text-foreground"
                onClick={handleAddProject}
                disabled={!canAddProject}
              >
                <span>{addProjectActionLabel}</span>
                <span className="rounded border border-border/60 bg-background/50 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                  Enter
                </span>
              </Button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-4 py-3">
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/50 mb-2">
                  {projectPickerStep === "environment"
                    ? "Available Environments"
                    : "Browse Directories"}
                </p>
                {projectPickerStep === "directory" && selectedProjectPickerEnvironment ? (
                  <p className="text-xs text-muted-foreground/70">
                    Target:{" "}
                    <span className="font-semibold text-foreground">
                      {selectedProjectPickerEnvironment.name}
                    </span>
                  </p>
                ) : null}
              </div>
              <ScrollArea ref={projectPickerListRef} className="min-h-0 flex-1">
                {projectPickerStep === "environment" ? (
                  filteredPickerEnvironments.length > 0 ? (
                    filteredPickerEnvironments.map((environment, index) => (
                      <Button
                        key={environment.id}
                        type="button"
                        variant="ghost"
                        data-project-picker-environment-index={index}
                        className={`flex h-auto w-full justify-start gap-3 border-border/20 border-b px-4 py-3 text-left transition-all duration-150 last:border-b-0 ${
                          index === resolvedActiveProjectBrowseIndex
                            ? "bg-accent/70 text-foreground"
                            : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                        }`}
                        onMouseEnter={() => {
                          if (
                            shouldUseProjectPickerHoverSelection(
                              lastKeyboardNavigationTimeRef.current,
                            )
                          ) {
                            setActiveProjectBrowseIndex(index);
                          }
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void handleSelectProjectPickerEnvironment(environment)}
                        disabled={projectPickerEnvironmentProbeId !== null}
                      >
                        {environment.icon ? (
                          <ProjectGlyphIcon icon={environment.icon} className="size-5 shrink-0" />
                        ) : (
                          <LaptopIcon
                            className="size-5 shrink-0 text-muted-foreground/60"
                            strokeWidth={2}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-sm">
                            {environment.name}
                          </span>
                          <span className="block truncate text-muted-foreground text-xs font-normal">
                            {environment.subtitle}
                          </span>
                        </div>
                        {environment.isLocal ? (
                          <span className="rounded-lg border border-emerald-500/40 bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-400/90 shrink-0">
                            Local
                          </span>
                        ) : projectPickerEnvironmentProbeId === environment.id ? (
                          <span className="rounded-lg border border-amber-500/40 bg-amber-500/12 px-2 py-1 text-[11px] font-medium text-amber-400/90 shrink-0">
                            Checking…
                          </span>
                        ) : environment.isConnected ? (
                          <span className="rounded-lg border border-blue-500/40 bg-blue-500/12 px-2 py-1 text-[11px] font-medium text-blue-400/90 shrink-0">
                            Connected
                          </span>
                        ) : null}
                      </Button>
                    ))
                  ) : (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                      No matching environments
                    </p>
                  )
                ) : projectBrowseState.isBrowsing || isWaitingForCurrentProjectBrowse ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                    Browsing directories…
                  </p>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      className="flex h-auto w-full justify-start gap-3 border-border/20 border-b px-4 py-2.5 text-left text-sm font-medium text-muted-foreground/70 transition-all hover:bg-accent/40 hover:text-foreground"
                      onClick={handleBrowseParentPath}
                      disabled={isAddingProject}
                    >
                      <ArrowUpIcon className="size-4" strokeWidth={2} />
                      <span className="font-semibold">..</span>
                    </Button>
                    {currentProjectBrowseResult?.entries.length ? (
                      currentProjectBrowseResult.entries.map((entry, index) => (
                        <Button
                          key={entry.fullPath}
                          type="button"
                          variant="ghost"
                          data-project-picker-index={index}
                          className={`flex h-auto w-full justify-start gap-3 border-border/20 border-b px-4 py-2.5 text-left transition-all duration-150 last:border-b-0 ${
                            index === resolvedActiveProjectBrowseIndex
                              ? "bg-accent/70 text-foreground"
                              : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onMouseEnter={() => {
                            if (
                              shouldUseProjectPickerHoverSelection(
                                lastKeyboardNavigationTimeRef.current,
                              )
                            ) {
                              setActiveProjectBrowseIndex(index);
                            }
                          }}
                          onClick={() => handleBrowseProjectEntry(entry.fullPath)}
                        >
                          <FolderIcon
                            className="size-4 shrink-0 text-muted-foreground/60"
                            strokeWidth={2}
                          />
                          <span className="truncate font-medium text-sm">{entry.name}</span>
                        </Button>
                      ))
                    ) : (
                      <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                        No directories found
                      </p>
                    )}
                  </>
                )}
              </ScrollArea>
              {addProjectError ? (
                <p className="pt-2 text-xs leading-tight text-red-400/80 font-medium">
                  {addProjectError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-border/40 bg-muted/30 px-4 py-2.5 text-muted-foreground text-xs gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex gap-0.5">
                  <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
                    ↑
                  </span>
                  <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
                    ↓
                  </span>
                </span>
                <span className="font-medium">Navigate</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded border border-border/50 bg-background/50 px-2 py-0.5 text-[10px] font-medium text-foreground/70">
                  Enter
                </span>
                <span className="font-medium">Select</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
                  ⌫
                </span>
                <span className="font-medium">Back</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded border border-border/50 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70">
                  Esc
                </span>
                <span className="font-medium">Close</span>
              </span>
            </div>
          </div>
        </CommandDialogPopup>
      </CommandDialog>

      {shouldUseDesktopHeaderChrome ? (
        <SidebarHeader
          className={cn("drag-region", DESKTOP_HEADER_CHROME_CLASS_NAME)}
          style={MAC_TITLEBAR_LEFT_INSET_STYLE}
        >
          {sidebarHeaderChrome}
        </SidebarHeader>
      ) : (
        <SidebarHeader>{sidebarHeaderChrome}</SidebarHeader>
      )}

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
            <SidebarGroup className="px-2 pt-2 pb-0">
              <Alert
                variant="warning"
                className={cn(GLASS_BANNER_CLASS_NAME, GLASS_BANNER_WARNING_CLASS_NAME)}
              >
                <TriangleAlertIcon />
                <AlertTitle>Intel build on Apple Silicon</AlertTitle>
                <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
                {desktopUpdateButtonAction !== "none" ? (
                  <AlertAction>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={desktopUpdateButtonDisabled}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      {desktopUpdateButtonAction === "download"
                        ? "Download ARM build"
                        : "Install ARM build"}
                    </Button>
                  </AlertAction>
                ) : null}
              </Alert>
            </SidebarGroup>
          ) : null}
          <SidebarGroup className="px-2.5 pt-5 pb-0">
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                className="group/sidebar-new-chat flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
                onClick={handleStartSidebarNewChat}
                disabled={!sidebarNewThreadProjectId}
                aria-label="New chat"
              >
                <SquarePenIcon className="size-3.5 shrink-0 transition-colors group-hover/sidebar-new-chat:text-sidebar-accent-foreground" />
                <span className="min-w-0 flex-1 truncate">New chat</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="group/sidebar-search flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                onClick={openSearchPalette}
                aria-label="Open search"
              >
                <IconSearch className="size-3.5 shrink-0 transition-colors group-hover/sidebar-search:text-sidebar-accent-foreground" />
                <span className="min-w-0 flex-1 truncate">Search</span>
                {searchShortcutLabel ? (
                  <span className="rounded-md bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-semibold text-sidebar-foreground/70 transition-colors group-hover/sidebar-search:text-sidebar-accent-foreground">
                    {searchShortcutLabel}
                  </span>
                ) : null}
              </Button>
            </div>
          </SidebarGroup>
          <SidebarContent ref={sidebarContentScrollRef} className="gap-0 pt-1.5">
            <div ref={sidebarProjectListOffsetSourceRef} className="flex shrink-0 flex-col">
              {sortedRenderedPinnedItems.length > 0 ? (
                <SidebarGroup className="shrink-0 px-2.5 pt-5 pb-2">
                  <div className="group/section-row mb-1.5 flex items-center justify-between pl-2 pr-1.5">
                    <button
                      type="button"
                      className="group/section-header flex h-5 min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left"
                      aria-expanded={pinnedSectionExpanded}
                      onClick={() => setPinnedSectionExpanded(!pinnedSectionExpanded)}
                    >
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors group-hover/section-header:text-foreground">
                        Pinned
                      </span>
                      <ChevronRightIcon
                        className={`size-4 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/section-header:text-foreground group-hover/section-header:opacity-100 ${
                          pinnedSectionExpanded ? "rotate-90" : ""
                        }`}
                      />
                    </button>
                  </div>
                  <div
                    aria-hidden={!pinnedSectionExpanded}
                    className={cn(
                      "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                      pinnedSectionExpanded
                        ? "grid-rows-[1fr] opacity-100"
                        : "pointer-events-none grid-rows-[0fr] opacity-0",
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0.5 border-l-0 px-0 py-0.5">
                        {sortedRenderedPinnedItems.map((item) =>
                          item.kind === "thread" ? (
                            renderPinnedThreadRow(item.threadId)
                          ) : (
                            <SidebarMenuItem
                              key={`pinned-project:${item.projectId}`}
                              className="mt-2 rounded-md"
                            >
                              <SidebarLocalProjectItem
                                activeRouteConnectionUrl={activeRouteConnectionUrl}
                                activeSidebarRouteThreadId={activeSidebarRouteThreadId}
                                appSettingsConfirmThreadArchive={confirmThreadArchive}
                                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                                confirmingArchiveThreadId={confirmingArchiveThreadId}
                                connectionUrl={activeWsUrl}
                                createBoardThreadRowDragProps={createBoardThreadRowDragProps}
                                dragHandleProps={null}
                                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                                handleProjectContextMenu={handleProjectContextMenu}
                                handleProjectTitleClick={handleProjectTitleClick}
                                handleProjectTitleKeyDown={handleProjectTitleKeyDown}
                                handleProjectTitlePointerDownCapture={
                                  handleProjectTitlePointerDownCapture
                                }
                                handleStartNewThreadForProject={handleStartNewThreadForProject}
                                handleThreadClick={handleThreadClick}
                                handleThreadContextMenu={handleThreadContextMenu}
                                isPinned={pinnedProjectIdSet.has(item.projectId)}
                                jumpLabelByThreadId={threadJumpLabelById}
                                markProjectContextMenuPending={markProjectContextMenuPending}
                                newThreadShortcutLabel={newThreadShortcutLabel}
                                onCollapseThreadList={collapseThreadListForProject}
                                onExpandThreadList={expandThreadListForProject}
                                onTogglePinnedProject={togglePinnedProject}
                                onTogglePinnedThread={togglePinnedThread}
                                openPrLink={openPrLink}
                                pinnedThreadIdSet={pinnedThreadIdSet}
                                prByThreadId={prByThreadId}
                                prefetchThreadHistory={prefetchThreadHistory}
                                projectId={item.projectId}
                                renamingCommittedRef={renamingCommittedRef}
                                renamingInputRef={renamingInputRef}
                                renamingThreadId={null}
                                renamingTitle={renamingTitle}
                                routeThreadId={activeSidebarRouteThreadId}
                                selectedThreadIds={selectedThreadIds}
                                setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
                                setRenamingTitle={setRenamingTitle}
                                showThreadJumpHints={showThreadJumpHints}
                                threadRevealCount={
                                  threadRevealCountByProject[item.projectId] ?? THREAD_REVEAL_STEP
                                }
                                threadSortOrder={sidebarThreadSortOrder}
                                clearSelection={clearSelection}
                                commitRename={commitRename}
                                cancelRename={cancelRename}
                                attemptArchiveThread={attemptArchiveThread}
                                navigateToThread={navigateToThread}
                              />
                            </SidebarMenuItem>
                          ),
                        )}
                      </SidebarMenuSub>
                    </div>
                  </div>
                </SidebarGroup>
              ) : null}
            </div>
            {savedBoards.length > 0 ? (
              <SidebarBoardsSection
                activeSplitId={activeStoreSplitId}
                boardItems={savedBoardItems}
                boardsSectionExpanded={boardsSectionExpanded}
                canCollapseSplitList={canCollapseSplitList}
                canCreateBoard={splitPickerAvailableThreadCount >= 2}
                dragOverBoardId={
                  boardThreadDragState?.overTargetKey &&
                  savedBoards.some((split) => split.id === boardThreadDragState.overTargetKey)
                    ? boardThreadDragState.overTargetKey
                    : null
                }
                hiddenSavedSplitCount={hiddenSavedSplitCount}
                renamingSplitId={renamingSplitId}
                renamingSplitTitle={renamingSplitTitle}
                showMoreCount={Math.min(SPLIT_REVEAL_STEP, hiddenSavedSplitCount)}
                splitSortOrder={splitSortOrder}
                threadDragActive={boardThreadDragState !== null}
                visibleBoardItems={visibleSavedBoardItems}
                onBoardsSectionToggle={() => {
                  setBoardsSectionExpanded(!boardsSectionExpanded);
                }}
                onBoardDragLeave={handleSavedBoardDragLeave}
                onBoardDragOver={handleSavedBoardDragOver}
                onBoardDrop={handleBoardThreadDropOnSavedBoard}
                onCancelSplitRename={cancelSplitRename}
                onCommitSplitRename={commitSplitRename}
                onArchiveSplit={(split) => {
                  void handleSplitMenuAction(split, "archive");
                }}
                onOpenSplitContextMenu={openSplitContextMenu}
                onOpenSplitPicker={openSplitPicker}
                onRestoreSavedSplit={restoreSavedSplit}
                onShowLess={() => setSplitRevealCount(SPLIT_REVEAL_STEP)}
                onShowMore={() => {
                  setSplitRevealCount((current) =>
                    Math.min(savedBoards.length, current + SPLIT_REVEAL_STEP),
                  );
                }}
                onSplitRenameChange={setRenamingSplitTitle}
                onSplitSortOrderChange={setSplitSortOrder}
              />
            ) : null}
            <SidebarGroup className="shrink-0 px-2.5 pt-2.5 pb-5">
              <SidebarProjectsSectionHeader
                addProjectShortcutLabel={addProjectShortcutLabel}
                canCollapseVisibleProjects={canCollapseVisibleProjects}
                projectSortOrder={sidebarProjectSortOrder}
                projectsSectionExpanded={projectsSectionExpanded}
                shouldShowProjectPathEntry={shouldShowProjectPathEntry}
                threadSortOrder={sidebarThreadSortOrder}
                onCollapseVisibleProjects={collapseVisibleProjects}
                onProjectSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarProjectSortOrder: sortOrder });
                }}
                onThreadSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarThreadSortOrder: sortOrder });
                }}
                onToggleAddProject={handleStartAddProject}
                onToggleProjectsSection={() => setProjectsSectionExpanded(!projectsSectionExpanded)}
              />
              <div
                aria-hidden={!projectsSectionExpanded}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                  projectsSectionExpanded
                    ? "grid-rows-[1fr] opacity-100"
                    : "pointer-events-none grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  {isProjectDraggingEnabled ? (
                    <DndContext
                      sensors={projectDnDSensors}
                      collisionDetection={sidebarProjectCollisionDetection}
                      modifiers={SIDEBAR_PROJECT_DND_MODIFIERS}
                      onDragStart={handleProjectDragStart}
                      onDragEnd={handleProjectDragEnd}
                      onDragCancel={handleProjectDragCancel}
                    >
                      <SortableContext
                        items={filteredLocalProjectIds}
                        strategy={verticalListSortingStrategy}
                      >
                        <SidebarProjectVirtualList
                          items={sidebarProjectListItems}
                          layoutMeasureKey={sidebarProjectListMeasureKey}
                          layoutSignature={sidebarProjectListLayoutSignature}
                          localProjectThreadGroupById={localProjectThreadGroupById}
                          offsetSourceRef={sidebarProjectListOffsetSourceRef}
                          prefetchThreadHistory={prefetchThreadHistory}
                          projectsSectionExpanded={projectsSectionExpanded}
                          renderItem={renderVirtualProjectListItem}
                          scrollElementRef={sidebarContentScrollRef}
                        />
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <SidebarProjectVirtualList
                      items={sidebarProjectListItems}
                      layoutMeasureKey={sidebarProjectListMeasureKey}
                      layoutSignature={sidebarProjectListLayoutSignature}
                      localProjectThreadGroupById={localProjectThreadGroupById}
                      offsetSourceRef={sidebarProjectListOffsetSourceRef}
                      prefetchThreadHistory={prefetchThreadHistory}
                      projectsSectionExpanded={projectsSectionExpanded}
                      renderItem={renderVirtualProjectListItem}
                      scrollElementRef={sidebarContentScrollRef}
                    />
                  )}
                  {projects.length === 0 &&
                    renderedRemoteProjects.length === 0 &&
                    !shouldShowProjectPathEntry && (
                      <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
                        No projects yet
                      </div>
                    )}
                  {(projects.length > 0 || remoteSidebarHosts.length > 0) &&
                    normalizedProjectSearchQuery.length > 0 &&
                    unifiedRenderedProjects.length === 0 && (
                      <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
                        No matching projects
                      </div>
                    )}
                </div>
              </div>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="p-2.5">
            <SidebarUpdatePill />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-8 gap-1.5 px-2.5 text-[13px] font-medium text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground"
                  onClick={() => void navigate({ to: "/settings" })}
                >
                  <IconSettings className="size-4" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </>
      )}
    </>
  );
}

export default function Sidebar() {
  return useSidebarComponent();
}
