import { IconSearch, IconSettings } from "@tabler/icons-react";
import {
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
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
import {
  type DesktopUpdateState,
  type FilesystemBrowseResult,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@ace/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { type SidebarProjectSortOrder } from "@ace/contracts/settings";
import { isElectron } from "../env";
import { APP_VERSION, IS_DEV_BUILD } from "../branding";
import { reportBackgroundError } from "../lib/async";
import { cn, randomUUID } from "../lib/utils";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  DESKTOP_HEADER_CHROME_CLASS_NAME,
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
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
import { getDefaultServerModel } from "../providerModels";

import { useThreadActions } from "../hooks/useThreadActions";
import {
  ProjectAvatar,
  ProjectGlyphIcon,
  PROJECT_ICON_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
} from "./ProjectAvatar";
import { toastManager } from "./ui/toast";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarSearchPaletteDialog } from "./sidebar/SidebarSearchPaletteDialog";
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
  isContextMenuPointerDown,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadOptions,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
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
import { prefetchHydratedThread, readCachedHydratedThread } from "../lib/threadHydrationCache";
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
  routeOrchestrationGetSnapshotFromRemote,
  unregisterRemoteRoute,
} from "../lib/remoteWsRouter";
import { LEAN_SNAPSHOT_RECOVERY_INPUT } from "../bootstrapRecovery";
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
const THREAD_REVEAL_STEP = 5;
const SPLIT_REVEAL_STEP = 5;
const SIDEBAR_PROJECT_ROW_BASE_ESTIMATE_PX = 32;
const SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX = 28;
const REMOTE_HOST_REFRESH_INTERVAL_MS = 20_000;
const REMOTE_HOST_HIDDEN_REFRESH_INTERVAL_MS = 90_000;
const REMOTE_HOST_INITIAL_RESOLVE_DELAY_MS = 1_500;
const REMOTE_SIDEBAR_SNAPSHOT_FETCH_CONCURRENCY = 2;
const REMOTE_SNAPSHOT_BACKGROUND_MERGE_TIMEOUT_MS = 600;

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
const REMOTE_SNAPSHOT_BACKGROUND_MERGE_DELAY_MS = 120;

function estimateSidebarProjectListItemSize(item: SidebarProjectListItem | undefined): number {
  if (!item) {
    return SIDEBAR_PROJECT_ROW_BASE_ESTIMATE_PX;
  }
  if (item.kind === "local") {
    return (
      SIDEBAR_PROJECT_ROW_BASE_ESTIMATE_PX +
      item.renderedThreadCount * SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX +
      item.auxiliaryRowCount * SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX
    );
  }
  return (
    SIDEBAR_PROJECT_ROW_BASE_ESTIMATE_PX +
    item.renderedProject.visibleThreads.length * SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX +
    (item.renderedProject.hasHiddenThreads ? SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX : 0) +
    (item.renderedProject.canCollapseThreadList ? SIDEBAR_PROJECT_THREAD_ROW_ESTIMATE_PX : 0)
  );
}

function getVirtualProjectRowStyle(virtualRow: VirtualItem): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${virtualRow.start}px)`,
  };
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
  const workers = Array.from({ length: limitedConcurrency }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }
      results[index] = await mapper(entry, index);
    }
  });
  await Promise.all(workers);
  return results;
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

function getLastUserMessageTimestamp(
  messages: OrchestrationReadModel["threads"][number]["messages"],
): string {
  let lastUserMessageAt = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === "user") {
      lastUserMessageAt = message.createdAt;
      break;
    }
  }
  return lastUserMessageAt;
}

function getProjectLastUserMessageAt(
  projectId: string,
  threads: OrchestrationReadModel["threads"],
): string {
  let latestTimestamp = "";
  for (const thread of threads) {
    if (thread.projectId !== projectId) continue;
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const threadLastUserAt = getLastUserMessageTimestamp(thread.messages);
    if (threadLastUserAt && (!latestTimestamp || threadLastUserAt > latestTimestamp)) {
      latestTimestamp = threadLastUserAt;
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
  snapshot: OrchestrationReadModel,
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
    const lastUserMessageAt = getLastUserMessageTimestamp(thread.messages);
    projectThreads.push({
      id: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      lastUserMessageAt: lastUserMessageAt || thread.updatedAt,
    });
    threadsByProjectId.set(thread.projectId, projectThreads);
  }

  return snapshot.projects
    .filter((project) => project.deletedAt === null && project.archivedAt === null)
    .map((project) => {
      const projectThreads = threadsByProjectId.get(project.id) ?? [];
      const lastUserMessageAt =
        getProjectLastUserMessageAt(project.id, snapshot.threads) || project.updatedAt;
      return {
        id: project.id,
        name: project.title,
        cwd: project.workspaceRoot,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastUserMessageAt,
        icon: project.icon ?? null,
        defaultModelSelection: project.defaultModelSelection,
        threads: sortThreadsFn(projectThreads),
      };
    })
    .toSorted(sortFn);
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

function renderSidebarHeaderTooltipContent(label: string, shortcutLabel: string | null) {
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

export default function Sidebar() {
  const { isMobile, state: sidebarState } = useSidebar();
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const readSidebarThreadSummary = useCallback(
    (threadId: ThreadId) => useStore.getState().sidebarThreadsById[threadId],
    [],
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
  const pinnedProjectIds = useMemo(
    () => pinnedItems.flatMap((item) => (item.kind === "project" ? [item.id] : [])),
    [pinnedItems],
  );
  const pinnedThreadIds = useMemo(
    () => pinnedItems.flatMap((item) => (item.kind === "thread" ? [item.id] : [])),
    [pinnedItems],
  );
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const { archiveThread, deleteThread } = useThreadActions();
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [projectPickerStep, setProjectPickerStep] = useState<ProjectPickerStep>("environment");
  const [projectPickerEnvironmentQuery, setProjectPickerEnvironmentQuery] = useState("");
  const [projectPickerRemoteHosts, setProjectPickerRemoteHosts] = useState<RemoteHostInstance[]>(
    [],
  );
  const [projectPickerConnectedHostIds, setProjectPickerConnectedHostIds] = useState<string[]>([]);
  const [projectPickerSelectedConnectionUrl, setProjectPickerSelectedConnectionUrl] = useState<
    string | null
  >(null);
  const [newCwd, setNewCwd] = useState("");
  const [isBrowsingProjectPaths, setIsBrowsingProjectPaths] = useState(false);
  const [projectBrowseResult, setProjectBrowseResult] = useState<FilesystemBrowseResult | null>(
    null,
  );
  const [projectBrowseLoadedPath, setProjectBrowseLoadedPath] = useState<string | null>(null);
  const [activeProjectBrowseIndex, setActiveProjectBrowseIndex] = useState(-1);
  const lastKeyboardNavigationTimeRef = useRef(0);
  const [projectPickerEnvironmentProbeId, setProjectPickerEnvironmentProbeId] = useState<
    string | null
  >(null);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const providerStatuses = useServerProviders({
    enabled: addingProject || isAddingProject,
  });
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const projectPickerListRef = useRef<HTMLDivElement | null>(null);
  const searchPaletteListRef = useRef<HTMLDivElement | null>(null);
  const sidebarContentScrollRef = useRef<HTMLDivElement | null>(null);
  const browseRequestVersionRef = useRef(0);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<ThreadId | null>(null);
  const [threadRevealCountByProject, setThreadRevealCountByProject] = useState<
    Partial<Record<ProjectId, number>>
  >({});
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [editingProjectConnectionUrl, setEditingProjectConnectionUrl] = useState<string | null>(
    null,
  );
  const [editingProjectName, setEditingProjectName] = useState("");
  const [editingProjectIcon, setEditingProjectIcon] = useState<Project["icon"]>(null);
  const [remoteThreadRenameTarget, setRemoteThreadRenameTarget] = useState<{
    connectionUrl: string;
    project: RemoteSidebarProjectEntry;
    thread: RemoteSidebarThreadEntry;
  } | null>(null);
  const [remoteThreadRenameTitle, setRemoteThreadRenameTitle] = useState("");
  const [splitSortOrder, setSplitSortOrder] = useState<SidebarSplitSortOrder>("updated_at");
  const [splitRevealCount, setSplitRevealCount] = useState(SPLIT_REVEAL_STEP);
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);
  const [splitPickerQuery, setSplitPickerQuery] = useState("");
  const [splitPickerProjectFilter, setSplitPickerProjectFilter] = useState<string>("all");
  const [splitPickerSortOrder, setSplitPickerSortOrder] = useState<SplitPickerSortOrder>("recent");
  const [splitPickerSelectedThreadIds, setSplitPickerSelectedThreadIds] = useState<Set<ThreadId>>(
    () => new Set(),
  );
  const [splitContextMenuState, setSplitContextMenuState] = useState<SplitContextMenuState | null>(
    null,
  );
  const [renamingSplitId, setRenamingSplitId] = useState<string | null>(null);
  const [renamingSplitTitle, setRenamingSplitTitle] = useState("");
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<ThreadId, HTMLButtonElement>());
  const sidebarHeaderRowRef = useRef<HTMLDivElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [boardThreadDragState, setBoardThreadDragState] = useState<BoardThreadDragState | null>(
    null,
  );
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
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
  const activeRouteConnectionUrl = useMemo(() => {
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
  }, [localDeviceConnectionUrl, locationSearch, routeThreadConnectionUrl]);
  const activeStoreSplitId =
    savedSplitBoard.activeSplitId && savedSplitBoard.panes.length > 1
      ? savedSplitBoard.activeSplitId
      : null;
  const savedBoards = useMemo(() => {
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
  }, [savedSplitBoard.splits, splitSortOrder]);
  const visibleSavedBoards = useMemo(
    () => savedBoards.slice(0, splitRevealCount),
    [savedBoards, splitRevealCount],
  );
  const hiddenSavedSplitCount = Math.max(0, savedBoards.length - visibleSavedBoards.length);
  const canCollapseSplitList = splitRevealCount > SPLIT_REVEAL_STEP;
  const contextMenuSplit = useMemo(
    () =>
      splitContextMenuState
        ? (savedBoards.find((split) => split.id === splitContextMenuState.splitId) ?? null)
        : null,
    [savedBoards, splitContextMenuState],
  );
  useEffect(() => {
    setSplitRevealCount(SPLIT_REVEAL_STEP);
  }, [splitSortOrder]);
  const buildSplitTitle = useCallback(
    (threads: ReadonlyArray<{ threadId: ThreadId }>) => {
      return buildThreadBoardTitle({
        fallbackIndex: savedSplitBoard.splits.length + 1,
        threads: threads.map((thread) => ({
          threadId: thread.threadId,
          title: sidebarThreadsById[thread.threadId]?.title,
        })),
      });
    },
    [savedSplitBoard.splits.length, sidebarThreadsById],
  );
  const clearBoardThreadDrag = useCallback(() => {
    setActiveThreadBoardDrag(null);
    setBoardThreadDragState(null);
  }, []);
  const setBoardThreadDragOverTarget = useCallback((targetKey: string | null) => {
    setBoardThreadDragState((current) => {
      if (!current || current.overTargetKey === targetKey) {
        return current;
      }
      return {
        ...current,
        overTargetKey: targetKey,
      };
    });
  }, []);
  const readBoardThreadDrag = useCallback(
    (event?: DragEvent<HTMLElement>): ThreadBoardDragThread | null => {
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
    },
    [boardThreadDragState],
  );
  const restoreSavedSplit = useCallback(
    (split: ChatThreadBoardSplitState, targetPane?: ChatThreadBoardPaneState | null) => {
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
          useHostConnectionStore
            .getState()
            .upsertThreadOwnership(pane.connectionUrl, pane.threadId);
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
    },
    [activeStoreSplitId, navigate, savedSplitBoard.activePaneId],
  );
  const navigateToBoardThreadRoute = useCallback(
    (activePane: { connectionUrl: string | null; threadId: ThreadId }) => {
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: activePane.threadId },
          search: buildSingleThreadRouteSearch({ connectionUrl: activePane.connectionUrl }),
        });
      });
    },
    [navigate],
  );
  const buildBoardFromDraggedThreads = useCallback(
    (
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
    },
    [buildSplitTitle, navigateToBoardThreadRoute],
  );
  const handleBoardThreadDragStart = useCallback(
    (
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
      setBoardThreadDragState({
        activeThread: dragThread,
        activeThreadKey: getThreadBoardDragThreadKey(dragThread),
        overTargetKey: null,
      });
    },
    [setBoardsSectionExpanded, sidebarThreadsById],
  );
  const handleBoardThreadDropOnThread = useCallback(
    (
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
    },
    [buildBoardFromDraggedThreads, clearBoardThreadDrag, readBoardThreadDrag, sidebarThreadsById],
  );
  const handleBoardThreadDropOnSavedBoard = useCallback(
    (split: ChatThreadBoardSplitState, event: DragEvent<HTMLLIElement>) => {
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
    },
    [clearBoardThreadDrag, readBoardThreadDrag, restoreSavedSplit],
  );
  const createBoardThreadRowDragProps = useCallback(
    (thread: { connectionUrl: string | null; threadId: ThreadId }) => {
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
    },
    [
      boardThreadDragState,
      clearBoardThreadDrag,
      handleBoardThreadDragStart,
      handleBoardThreadDropOnThread,
      readBoardThreadDrag,
      setBoardThreadDragOverTarget,
    ],
  );
  const handleSavedBoardDragLeave = useCallback(
    (splitId: string, event: DragEvent<HTMLLIElement>) => {
      const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      if (boardThreadDragState?.overTargetKey === splitId) {
        setBoardThreadDragOverTarget(null);
      }
    },
    [boardThreadDragState?.overTargetKey, setBoardThreadDragOverTarget],
  );
  const handleSavedBoardDragOver = useCallback(
    (split: ChatThreadBoardSplitState, event: DragEvent<HTMLLIElement>) => {
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
    },
    [readBoardThreadDrag, setBoardThreadDragOverTarget],
  );
  const openThreadInSplit = useCallback(
    (target: {
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
    },
    [
      activeStoreSplitId,
      buildSplitTitle,
      navigateToBoardThreadRoute,
      routeThreadId,
      savedSplitBoard.activePaneId,
      sidebarThreadsById,
    ],
  );
  const openThreadsInSplit = useCallback(
    (
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
    },
    [
      activeStoreSplitId,
      buildSplitTitle,
      navigateToBoardThreadRoute,
      routeThreadId,
      savedSplitBoard.activePaneId,
      sidebarThreadsById,
    ],
  );
  const closeActiveSplitRoute = useCallback(() => {
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
  }, [navigate, routeThreadId]);
  const cancelSplitRename = useCallback(() => {
    setRenamingSplitId(null);
    setRenamingSplitTitle("");
  }, []);
  const commitSplitRename = useCallback(
    (split: ChatThreadBoardSplitState) => {
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
    },
    [cancelSplitRename, renamingSplitTitle],
  );
  const closeSplitContextMenu = useCallback(() => {
    setSplitContextMenuState(null);
  }, []);
  const openSplitContextMenu = useCallback(
    (split: ChatThreadBoardSplitState, position: { x: number; y: number }) => {
      setSplitContextMenuState({ position, splitId: split.id });
    },
    [],
  );
  const handleSplitMenuAction = useCallback(
    async (split: ChatThreadBoardSplitState, action: "archive" | "delete" | "open" | "rename") => {
      closeSplitContextMenu();
      if (action === "open") {
        restoreSavedSplit(split);
        return;
      }
      if (action === "rename") {
        setRenamingSplitId(split.id);
        setRenamingSplitTitle(split.title);
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
    },
    [activeStoreSplitId, closeActiveSplitRoute, closeSplitContextMenu, restoreSavedSplit],
  );
  const [remoteSidebarHosts, setRemoteSidebarHosts] = useState<
    ReadonlyArray<RemoteSidebarHostEntry>
  >(() => remoteSidebarHostSnapshotCache);
  const remoteSidebarHostsRef = useRef<ReadonlyArray<RemoteSidebarHostEntry>>(
    remoteSidebarHostSnapshotCache,
  );
  const registeredRemoteRouteConnectionUrlsRef = useRef<Set<string>>(new Set());
  const remoteSnapshotSequenceByConnectionRef = useRef<Map<string, number>>(new Map());
  const pendingRemoteSnapshotMergeByConnectionRef = useRef<Map<string, OrchestrationReadModel>>(
    new Map(),
  );
  const remoteSnapshotMergeScheduledRef = useRef(false);
  const remoteSnapshotMergeHandleRef = useRef<{ kind: "idle" | "timeout"; id: number } | null>(
    null,
  );
  const remoteSidebarRefreshVersionRef = useRef(0);
  const remoteSidebarRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const [remoteProjectExpandedById, setRemoteProjectExpandedById] = useState<
    Record<string, boolean>
  >({});
  const [remoteThreadRevealCountByProject, setRemoteThreadRevealCountByProject] = useState<
    Record<string, number>
  >({});
  const projectConnectionById = useHostConnectionStore((store) => store.projectConnectionById);
  useEffect(() => {
    remoteSidebarHostsRef.current = remoteSidebarHosts;
    remoteSidebarHostSnapshotCache = remoteSidebarHosts;
  }, [remoteSidebarHosts]);
  const shouldShowProjectPathEntry = addingProject;
  const normalizedProjectSearchQuery = "";
  const activeProjects = useMemo(
    () =>
      projects.filter((project) => {
        if (project.archivedAt !== null) {
          return false;
        }
        const ownerConnectionUrl = projectConnectionById[project.id];
        return (
          ownerConnectionUrl === undefined ||
          connectionUrlsEqual(ownerConnectionUrl, localDeviceConnectionUrl)
        );
      }),
    [localDeviceConnectionUrl, projectConnectionById, projects],
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: activeProjects,
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
  }, [activeProjects, projectOrder]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectById = useMemo(
    () => new Map(activeProjects.map((project) => [project.id, project] as const)),
    [activeProjects],
  );
  const savedBoardItems = useMemo(
    () =>
      savedBoards.map((split) =>
        buildSidebarBoardListItem({
          projectById,
          split,
          threadById: sidebarThreadsById,
        }),
      ),
    [projectById, savedBoards, sidebarThreadsById],
  );
  const visibleSavedBoardItems = useMemo(
    () => savedBoardItems.slice(0, splitRevealCount),
    [savedBoardItems, splitRevealCount],
  );
  const pickerEnvironments = useMemo((): ProjectPickerEnvironment[] => {
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
  }, [
    localDeviceConnectionUrl,
    localDeviceHost,
    projectPickerConnectedHostIds,
    projectPickerRemoteHosts,
  ]);
  const selectedProjectPickerEnvironment = useMemo(() => {
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
  }, [pickerEnvironments, projectPickerSelectedConnectionUrl]);
  const selectedProjectPickerConnectionUrl =
    selectedProjectPickerEnvironment?.connectionUrl ?? localDeviceConnectionUrl;
  const selectedProjectPickerIsLocal = selectedProjectPickerEnvironment?.isLocal ?? true;
  const selectedProjectPickerName = selectedProjectPickerEnvironment?.name ?? "remote host";
  const normalizedProjectPickerEnvironmentQuery = projectPickerEnvironmentQuery
    .trim()
    .toLowerCase();
  const filteredPickerEnvironments = useMemo(() => {
    if (normalizedProjectPickerEnvironmentQuery.length === 0) {
      return pickerEnvironments;
    }
    return pickerEnvironments.filter(
      (environment) =>
        environment.name.toLowerCase().includes(normalizedProjectPickerEnvironmentQuery) ||
        environment.subtitle.toLowerCase().includes(normalizedProjectPickerEnvironmentQuery),
    );
  }, [normalizedProjectPickerEnvironmentQuery, pickerEnvironments]);
  const reconcileThreadDerivedState = useCallback(() => {
    const threads = useStore.getState().threads;
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
    clearPromotedDraftThreads(threads.map((thread) => thread.id));
  }, []);
  const clearRemoteSnapshotMergeHandle = useCallback(() => {
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
  }, []);
  const flushRemoteSnapshotMergeQueue = useCallback(() => {
    remoteSnapshotMergeScheduledRef.current = false;
    remoteSnapshotMergeHandleRef.current = null;
    const pending = pendingRemoteSnapshotMergeByConnectionRef.current;
    if (pending.size === 0) {
      return;
    }

    const merges = [...pending.entries()];
    pending.clear();
    const store = useStore.getState();
    for (const [connectionUrl, snapshot] of merges) {
      store.mergeServerReadModel(snapshot, {
        ...LEAN_SNAPSHOT_RECOVERY_INPUT,
        connectionUrl,
      });
    }
    reconcileThreadDerivedState();
  }, [reconcileThreadDerivedState]);
  const scheduleRemoteSnapshotMergeFlush = useCallback(() => {
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
  }, [flushRemoteSnapshotMergeQueue]);
  const refreshRemoteSidebarHosts = useCallback(async () => {
    const existingRefresh = remoteSidebarRefreshInFlightRef.current;
    if (existingRefresh) {
      return existingRefresh;
    }

    const refreshPromise = (async () => {
      const connectedHostIds = new Set(loadConnectedRemoteHostIds());
      const hosts = loadRemoteHostInstances()
        .filter((host) => connectedHostIds.has(host.id))
        .filter((host) => resolveHostConnectionWsUrl(host) !== localDeviceConnectionUrl)
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const nextConnectionUrls = new Set<string>(
        hosts.map((host) => resolveHostConnectionWsUrl(host)),
      );
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
            const snapshot = (await routeOrchestrationGetSnapshotFromRemote(
              connectionUrl,
              LEAN_SNAPSHOT_RECOVERY_INPUT,
            )) as OrchestrationReadModel;
            const previousSequence =
              remoteSnapshotSequenceByConnectionRef.current.get(connectionUrl);
            const hasNewSnapshot = previousSequence !== snapshot.snapshotSequence;
            if (hasNewSnapshot) {
              useHostConnectionStore.getState().upsertSnapshotOwnership(connectionUrl, snapshot);
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
    } finally {
      if (remoteSidebarRefreshInFlightRef.current === refreshPromise) {
        remoteSidebarRefreshInFlightRef.current = null;
      }
    }
  }, [
    sidebarProjectSortOrder,
    clearRemoteSnapshotMergeHandle,
    localDeviceConnectionUrl,
    reconcileThreadDerivedState,
    scheduleRemoteSnapshotMergeFlush,
  ]);
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
        await refreshRemoteSidebarHosts();
      } finally {
        schedule(resolveRefreshDelay());
      }
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
    return () => {
      cancelled = true;
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
      clearRemoteSnapshotMergeHandle();
      pendingRemoteSnapshotMergeByConnection.clear();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const connectionUrl of registeredRemoteRouteConnectionUrlsRef.current) {
        unregisterRemoteRoute(connectionUrl);
      }
      registeredRemoteRouteConnectionUrlsRef.current.clear();
    };
  }, [bootstrapComplete, clearRemoteSnapshotMergeHandle, refreshRemoteSidebarHosts]);
  const addProjectBaseDirectory = useMemo(() => {
    const configuredBaseDirectory = configuredAddProjectBaseDirectory.trim();
    return configuredBaseDirectory.length > 0 ? configuredBaseDirectory : "~";
  }, [configuredAddProjectBaseDirectory]);
  const editingProject = useMemo(
    () =>
      editingProjectId
        ? (projects.find((project) => project.id === editingProjectId) ?? null)
        : null,
    [editingProjectId, projects],
  );
  const editingRemoteProject = useMemo(() => {
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
  }, [editingProjectConnectionUrl, editingProjectId, remoteSidebarHosts]);
  const editingProjectTarget = editingProject ?? editingRemoteProject;
  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );

  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
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
  }, []);

  const removeRemoteThreadFromSidebarById = useCallback(
    (input: { connectionUrl: string; threadId: ThreadId }) => {
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
    },
    [removeFromSelection],
  );
  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId, connectionUrl: string) => {
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
    },
    [
      archiveThread,
      localDeviceConnectionUrl,
      refreshRemoteSidebarHosts,
      removeRemoteThreadFromSidebarById,
    ],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const sortedThreads = sortThreadsForSidebar(
        (threadIdsByProjectId[projectId] ?? [])
          .map((threadId) => sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        sidebarThreadSortOrder,
      );
      const latestThread = sortedThreads[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [sidebarThreadSortOrder, navigate, sidebarThreadsById, threadIdsByProjectId],
  );

  const refreshProjectBrowse = useCallback(
    async (partialPath: string) => {
      const trimmedPath = partialPath.trim();
      if (!addingProject || projectPickerStep !== "directory" || !trimmedPath) {
        setProjectBrowseResult(null);
        setProjectBrowseLoadedPath(null);
        setActiveProjectBrowseIndex(-1);
        return;
      }

      const requestVersion = browseRequestVersionRef.current + 1;
      browseRequestVersionRef.current = requestVersion;
      setIsBrowsingProjectPaths(true);
      try {
        const browseResult = await routeFilesystemBrowseToRemote(
          selectedProjectPickerConnectionUrl,
          {
            partialPath: trimmedPath,
          },
        );
        if (browseRequestVersionRef.current !== requestVersion) {
          return;
        }
        setProjectBrowseLoadedPath(trimmedPath);
        setProjectBrowseResult(browseResult);
        setActiveProjectBrowseIndex(browseResult.entries.length > 0 ? 0 : -1);
      } catch (error) {
        if (browseRequestVersionRef.current !== requestVersion) {
          return;
        }
        setProjectBrowseLoadedPath(trimmedPath);
        setProjectBrowseResult(null);
        setActiveProjectBrowseIndex(-1);
        setAddProjectError(
          error instanceof Error ? error.message : "Unable to browse this directory path.",
        );
      } finally {
        if (browseRequestVersionRef.current === requestVersion) {
          setIsBrowsingProjectPaths(false);
        }
      }
    },
    [addingProject, projectPickerStep, selectedProjectPickerConnectionUrl],
  );

  useEffect(() => {
    if (!addingProject || projectPickerStep !== "directory") {
      setProjectBrowseResult(null);
      setProjectBrowseLoadedPath(null);
      setActiveProjectBrowseIndex(-1);
      setIsBrowsingProjectPaths(false);
      return;
    }
    const trimmedPath = newCwd.trim();
    if (!trimmedPath) {
      setProjectBrowseResult(null);
      setProjectBrowseLoadedPath(null);
      setActiveProjectBrowseIndex(-1);
      return;
    }
    void refreshProjectBrowse(trimmedPath);
  }, [addingProject, newCwd, projectPickerStep, refreshProjectBrowse]);

  useEffect(() => {
    if (!addingProject) {
      return;
    }
    addProjectInputRef.current?.focus();
  }, [addingProject]);

  const addProjectFromPath = useCallback(
    async (rawCwd: string, options?: { revealOnError?: boolean }) => {
      const isLocalEnvironment = selectedProjectPickerIsLocal;
      const targetConnectionUrl = selectedProjectPickerConnectionUrl;
      const cwd = resolveProjectPath(
        rawCwd,
        isLocalEnvironment ? addProjectBaseDirectory : undefined,
      ).trim();
      if (!cwd || isAddingProject) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setProjectBrowseResult(null);
        setActiveProjectBrowseIndex(-1);
        setAddingProject(false);
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
            reportBackgroundError(
              "Failed to create the initial thread for the new project.",
              error,
            );
          });
        }
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        setNewCwd(cwd);
        if (options?.revealOnError) {
          setAddingProject(true);
        }
        setAddProjectError(description);
        return;
      }
      finishAddingProject();
    },
    [
      addProjectBaseDirectory,
      defaultThreadEnvMode,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      localDeviceConnectionUrl,
      providerStatuses,
      projects,
      refreshRemoteSidebarHosts,
      selectedProjectPickerConnectionUrl,
      selectedProjectPickerIsLocal,
      selectedProjectPickerName,
    ],
  );

  const handleAddProject = useCallback(() => {
    void addProjectFromPath(newCwd);
  }, [addProjectFromPath, newCwd]);

  const canAddProject =
    projectPickerStep === "directory" && newCwd.trim().length > 0 && !isAddingProject;
  const currentProjectBrowsePath = newCwd.trim();
  const currentProjectBrowseResult =
    projectBrowseLoadedPath !== null && projectBrowseLoadedPath === currentProjectBrowsePath
      ? projectBrowseResult
      : null;
  const isWaitingForCurrentProjectBrowse =
    projectPickerStep === "directory" &&
    currentProjectBrowsePath.length > 0 &&
    currentProjectBrowseResult === null &&
    addProjectError === null;

  const handleBrowseProjectEntry = useCallback((fullPath: string) => {
    setAddProjectError(null);
    setNewCwd(toBrowseDirectoryPath(fullPath));
  }, []);

  const handleBrowseParentPath = useCallback(() => {
    const currentPath = currentProjectBrowseResult?.parentPath ?? newCwd.trim();
    if (!currentPath) {
      return;
    }
    const nextPath = parentPath(currentPath);
    if (!nextPath || nextPath === currentPath) {
      return;
    }
    setNewCwd(toBrowseDirectoryPath(nextPath));
    setAddProjectError(null);
  }, [currentProjectBrowseResult, newCwd]);

  const normalizedResolvedProjectPath = useMemo(() => {
    const shouldResolveAsLocal = selectedProjectPickerIsLocal;
    return resolveProjectPath(newCwd, shouldResolveAsLocal ? addProjectBaseDirectory : undefined)
      .trim()
      .toLowerCase();
  }, [addProjectBaseDirectory, newCwd, selectedProjectPickerIsLocal]);
  const isBrowsePathExactDirectoryMatch = useMemo(() => {
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
  }, [currentProjectBrowseResult, newCwd, normalizedResolvedProjectPath]);
  const addProjectActionLabel = isAddingProject
    ? "Adding..."
    : isBrowsePathExactDirectoryMatch
      ? "Add"
      : "Create & Add";

  const handleSelectProjectPickerEnvironment = useCallback(
    async (environment: ProjectPickerEnvironment) => {
      if (projectPickerEnvironmentProbeId !== null) {
        return;
      }
      setAddProjectError(null);
      if (!environment.isLocal) {
        setProjectPickerEnvironmentProbeId(environment.id);
        registerRemoteRoute(environment.connectionUrl);
        let availability: Awaited<ReturnType<typeof probeRemoteRouteAvailability>>;
        try {
          availability = await probeRemoteRouteAvailability(environment.connectionUrl, {
            force: true,
          });
        } finally {
          setProjectPickerEnvironmentProbeId(null);
        }
        if (availability.status !== "available") {
          setAddProjectError(
            availability.error?.trim().length
              ? availability.error
              : `Unable to reach ${environment.name}. We'll keep pinging it in the background.`,
          );
          return;
        }
      }
      setProjectPickerSelectedConnectionUrl(environment.connectionUrl);
      setProjectPickerStep("directory");
      const initialPath = environment.isLocal ? addProjectBaseDirectory : "~";
      setNewCwd(toBrowseDirectoryPath(initialPath));
      setProjectBrowseResult(null);
      setAddProjectError(null);
      setProjectPickerEnvironmentQuery("");
      setActiveProjectBrowseIndex(-1);
    },
    [addProjectBaseDirectory, projectPickerEnvironmentProbeId],
  );

  const handleAddProjectInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (projectPickerStep === "environment") {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveProjectBrowseIndex((index) => {
            if (filteredPickerEnvironments.length === 0) {
              return -1;
            }
            return Math.min(index + 1, filteredPickerEnvironments.length - 1);
          });
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
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const environment =
            activeProjectBrowseIndex >= 0
              ? filteredPickerEnvironments[activeProjectBrowseIndex]
              : filteredPickerEnvironments[0];
          if (environment) {
            void handleSelectProjectPickerEnvironment(environment);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setAddingProject(false);
          setAddProjectError(null);
          setProjectPickerEnvironmentProbeId(null);
          return;
        }
        if (event.key === "Backspace" && projectPickerEnvironmentQuery.trim().length === 0) {
          event.preventDefault();
          setAddingProject(false);
          setAddProjectError(null);
          setProjectPickerEnvironmentProbeId(null);
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
        return;
      }
      if (event.key === "ArrowRight") {
        const selectedEntry =
          activeProjectBrowseIndex >= 0
            ? currentProjectBrowseResult?.entries[activeProjectBrowseIndex]
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
          setProjectPickerStep("environment");
          setProjectPickerEnvironmentQuery("");
          setActiveProjectBrowseIndex(0);
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
        setAddingProject(false);
        setAddProjectError(null);
        setProjectPickerEnvironmentProbeId(null);
      }
    },
    [
      activeProjectBrowseIndex,
      filteredPickerEnvironments,
      handleAddProject,
      handleBrowseParentPath,
      handleBrowseProjectEntry,
      handleSelectProjectPickerEnvironment,
      projectPickerEnvironmentQuery,
      projectPickerStep,
      currentProjectBrowseResult,
      pickerEnvironments.length,
    ],
  );

  useEffect(() => {
    if (!addingProject) {
      return;
    }
    const itemCount =
      projectPickerStep === "environment"
        ? filteredPickerEnvironments.length
        : (currentProjectBrowseResult?.entries.length ?? 0);
    setActiveProjectBrowseIndex((currentIndex) => {
      if (itemCount === 0) {
        return -1;
      }
      if (currentIndex < 0) {
        return 0;
      }
      return Math.min(currentIndex, itemCount - 1);
    });
  }, [
    addingProject,
    currentProjectBrowseResult,
    filteredPickerEnvironments.length,
    projectPickerStep,
  ]);

  useEffect(() => {
    if (!addingProject || activeProjectBrowseIndex < 0) {
      return;
    }
    lastKeyboardNavigationTimeRef.current = Date.now();
    const listElement = projectPickerListRef.current;
    if (!listElement) {
      return;
    }
    const stepSelector =
      projectPickerStep === "environment"
        ? "data-project-picker-environment-index"
        : "data-project-picker-index";
    const activeItem = listElement.querySelector<HTMLElement>(
      `[${stepSelector}="${String(activeProjectBrowseIndex)}"]`,
    );
    if (!activeItem) {
      return;
    }
    activeItem.scrollIntoView({
      block: "center",
      behavior: "auto",
    });
  }, [activeProjectBrowseIndex, addingProject, projectPickerStep]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (shouldShowProjectPathEntry) {
      setAddingProject(false);
      setProjectPickerEnvironmentProbeId(null);
      return;
    }
    const remoteHosts = loadRemoteHostInstances();
    const connectedHostIds = loadConnectedRemoteHostIds();
    for (const host of remoteHosts) {
      if (!connectedHostIds.includes(host.id)) {
        continue;
      }
      const connectionUrl = resolveHostConnectionWsUrl(host);
      if (connectionUrl === localDeviceConnectionUrl) {
        continue;
      }
      registerRemoteRoute(connectionUrl);
    }
    setProjectPickerRemoteHosts(remoteHosts);
    setProjectPickerConnectedHostIds(connectedHostIds);
    setProjectPickerSelectedConnectionUrl(localDeviceConnectionUrl);
    const hasRemoteEnvironment = remoteHosts.some(
      (host) =>
        connectedHostIds.includes(host.id) &&
        resolveHostConnectionWsUrl(host) !== localDeviceConnectionUrl,
    );
    const initialPath = addProjectBaseDirectory;
    setProjectPickerStep(hasRemoteEnvironment ? "environment" : "directory");
    setProjectPickerEnvironmentQuery("");
    setNewCwd(hasRemoteEnvironment ? "" : toBrowseDirectoryPath(initialPath));
    setProjectBrowseResult(null);
    setActiveProjectBrowseIndex(-1);
    setAddingProject(true);
  }, [addProjectBaseDirectory, localDeviceConnectionUrl, shouldShowProjectPathEntry]);

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
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
    },
    [],
  );

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
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = readSidebarThreadSummary(threadId);
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "open-in-board", label: "Open in split" },
          { id: "pin", label: pinnedThreadIds.includes(threadId) ? "Unpin thread" : "Pin thread" },
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
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
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
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
    },
    [
      confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      openThreadInSplit,
      pinnedThreadIds,
      projectCwdById,
      readSidebarThreadSummary,
      togglePinnedThread,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
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
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      openThreadsInSplit,
      readSidebarThreadSummary,
      removeFromSelection,
      sidebarThreadsById,
      selectedThreadIds,
    ],
  );

  const handleThreadClick = useCallback(
    (
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
        startTransition(() => {
          useStore.getState().hydrateThreadFromReadModel(cached);
        });
      } else {
        prefetchHydratedThread(threadId, {
          expectedUpdatedAt: thread?.updatedAt ?? null,
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
    },
    [
      clearSelection,
      localDeviceConnectionUrl,
      navigate,
      rangeSelectTo,
      readSidebarThreadSummary,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const prefetchThreadHistory = useCallback(
    (threadId: ThreadId) => {
      const thread = readSidebarThreadSummary(threadId);
      if (!thread) {
        return;
      }
      const cached = readCachedHydratedThread(threadId, thread.updatedAt ?? null);
      if (cached) {
        return;
      }
      prefetchHydratedThread(threadId, {
        expectedUpdatedAt: thread.updatedAt ?? null,
      });
    },
    [readSidebarThreadSummary],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      const thread = readSidebarThreadSummary(threadId);
      const cached = thread ? readCachedHydratedThread(threadId, thread.updatedAt ?? null) : null;
      if (cached) {
        startTransition(() => {
          useStore.getState().hydrateThreadFromReadModel(cached);
        });
      } else {
        prefetchHydratedThread(threadId, {
          expectedUpdatedAt: thread?.updatedAt ?? null,
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
    },
    [
      clearSelection,
      navigate,
      readSidebarThreadSummary,
      selectedThreadIds.size,
      setSelectionAnchor,
    ],
  );
  const navigateToThreadOnConnection = useCallback(
    (connectionUrl: string, threadId: ThreadId) => {
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
        startTransition(() => {
          useStore.getState().hydrateThreadFromReadModel(cached);
        });
      } else {
        prefetchHydratedThread(threadId, {
          expectedUpdatedAt: thread?.updatedAt ?? null,
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
    },
    [
      clearSelection,
      localDeviceConnectionUrl,
      navigate,
      navigateToThread,
      readSidebarThreadSummary,
      selectedThreadIds.size,
      setSelectionAnchor,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
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
        setEditingProjectId(project.id);
        setEditingProjectConnectionUrl(activeWsUrl);
        setEditingProjectName(project.name);
        setEditingProjectIcon(project.icon);
        setProjectEditorOpen(true);
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
          const message =
            error instanceof Error ? error.message : "Unknown error archiving project.";
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
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      copyPathToClipboard,
      getDraftThreadByProjectId,
      activeWsUrl,
      pinnedProjectIds,
      projects,
      setEditingProjectIcon,
      setEditingProjectConnectionUrl,
      setEditingProjectId,
      setEditingProjectName,
      setProjectEditorOpen,
      threadIdsByProjectId,
      togglePinnedProject,
    ],
  );
  const handleRemoteProjectContextMenu = useCallback(
    async (
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
        setEditingProjectId(input.project.id);
        setEditingProjectConnectionUrl(input.connectionUrl);
        setEditingProjectName(input.project.name);
        setEditingProjectIcon(input.project.icon);
        setProjectEditorOpen(true);
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
    },
    [copyPathToClipboard, refreshRemoteSidebarHosts],
  );
  const handleRemoteThreadContextMenu = useCallback(
    async (
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
        setRemoteThreadRenameTarget(input);
        setRemoteThreadRenameTitle(input.thread.title);
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
    },
    [
      confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      openThreadInSplit,
      removeRemoteThreadFromSidebarById,
      refreshRemoteSidebarHosts,
    ],
  );
  const closeRemoteThreadRenameDialog = useCallback(() => {
    setRemoteThreadRenameTarget(null);
    setRemoteThreadRenameTitle("");
  }, []);
  const saveRemoteThreadRename = useCallback(async () => {
    const target = remoteThreadRenameTarget;
    if (!target) {
      return;
    }
    const nextTitle = remoteThreadRenameTitle.trim();
    if (nextTitle.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      return;
    }
    if (nextTitle === target.thread.title) {
      closeRemoteThreadRenameDialog();
      return;
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
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, [
    closeRemoteThreadRenameDialog,
    refreshRemoteSidebarHosts,
    remoteThreadRenameTarget,
    remoteThreadRenameTitle,
  ]);

  const closeProjectEditor = useCallback(() => {
    setProjectEditorOpen(false);
    setEditingProjectId(null);
    setEditingProjectConnectionUrl(null);
    setEditingProjectName("");
    setEditingProjectIcon(null);
  }, [setEditingProjectConnectionUrl]);

  const saveProjectEdits = useCallback(
    async (event?: { preventDefault: () => void }) => {
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
    },
    [
      closeProjectEditor,
      editingProject,
      editingProjectConnectionUrl,
      editingProjectIcon,
      editingProjectName,
      editingRemoteProject,
      activeWsUrl,
      refreshRemoteSidebarHosts,
    ],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
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
    },
    [orderedProjects, reorderProjects, sidebarProjectSortOrder, updateSettings],
  );

  const handleProjectDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, []);

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);
  const handleProjectTitlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
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
    },
    [],
  );

  const routeIsBoard = activeStoreSplitId !== null;
  const activeThreadId = routeIsBoard ? undefined : (routeThreadId ?? undefined);
  const activeSidebarRouteThreadId = activeThreadId ?? null;
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);
  const visibleProjectThreadsByProjectId = useMemo(() => {
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
  }, [activeProjects, sidebarThreadsById, threadIdsByProjectId]);
  const projectListThreadsByProjectId = useMemo(() => {
    const next = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of visibleProjectThreadsByProjectId) {
      const unpinnedThreads = projectThreads.filter((thread) => !pinnedThreadIdSet.has(thread.id));
      next.set(
        projectId,
        unpinnedThreads.length === projectThreads.length ? projectThreads : unpinnedThreads,
      );
    }
    return next;
  }, [pinnedThreadIdSet, visibleProjectThreadsByProjectId]);
  const sortedProjects = useMemo(() => {
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
  }, [
    activeProjects,
    sidebarProjectSortOrder,
    projectOrder,
    pinnedProjectIdSet,
    visibleProjectThreadsByProjectId,
  ]);
  const isProjectDraggingEnabled = normalizedProjectSearchQuery.length === 0;
  const sortedLocalProjectIds = useMemo(
    () => sortedProjects.map((project) => project.id),
    [sortedProjects],
  );
  const filteredLocalProjectIds = useMemo(() => {
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
  }, [
    normalizedProjectSearchQuery,
    pinnedProjectIdSet,
    projectById,
    sortedLocalProjectIds,
    visibleProjectThreadsByProjectId,
  ]);
  const localProjectThreadGroups = useMemo(
    () =>
      filteredLocalProjectIds.map((projectId) =>
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
      ),
    [
      activeThreadId,
      filteredLocalProjectIds,
      projectExpandedById,
      projectListThreadsByProjectId,
      sidebarThreadSortOrder,
      threadRevealCountByProject,
      visibleProjectThreadsByProjectId,
    ],
  );
  const localProjectThreadGroupById = useMemo(
    () =>
      new Map(
        filteredLocalProjectIds.map((projectId, index) => [
          projectId,
          localProjectThreadGroups[index],
        ]),
      ),
    [filteredLocalProjectIds, localProjectThreadGroups],
  );
  const renderedPinnedItems = useMemo<
    Array<{ kind: "project"; projectId: ProjectId } | { kind: "thread"; threadId: ThreadId }>
  >(
    () =>
      pinnedItems.flatMap<
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
      }),
    [pinnedItems, projectById, sidebarThreadsById],
  );
  const sortedRenderedPinnedItems = useMemo(
    () => [
      ...renderedPinnedItems.filter((item) => item.kind === "thread"),
      ...renderedPinnedItems.filter((item) => item.kind === "project"),
    ],
    [renderedPinnedItems],
  );
  const renderedPinnedThreadIds = useMemo(
    () =>
      sortedRenderedPinnedItems.flatMap((item) => (item.kind === "thread" ? [item.threadId] : [])),
    [sortedRenderedPinnedItems],
  );
  const filteredRemoteSidebarHosts = useMemo(() => {
    const visibleRemoteSidebarHosts = remoteSidebarHosts.filter(
      (entry) => !isHostConnectionActive(entry.host, activeWsUrl),
    );
    if (normalizedProjectSearchQuery.length === 0) {
      return visibleRemoteSidebarHosts;
    }
    return visibleRemoteSidebarHosts
      .map((entry) => {
        const connectionDescriptor = describeHostConnection(entry.host);
        const hostMatches =
          entry.host.name.toLowerCase().includes(normalizedProjectSearchQuery) ||
          connectionDescriptor.selectorValues.some((value) =>
            value.toLowerCase().includes(normalizedProjectSearchQuery),
          );
        const filteredProjects = entry.projects.filter((project) => {
          if (
            project.name.toLowerCase().includes(normalizedProjectSearchQuery) ||
            project.cwd.toLowerCase().includes(normalizedProjectSearchQuery)
          ) {
            return true;
          }
          return project.threads.some((thread) =>
            thread.title.toLowerCase().includes(normalizedProjectSearchQuery),
          );
        });
        if (hostMatches || filteredProjects.length > 0) {
          const projects = hostMatches ? entry.projects : filteredProjects;
          if (entry.error) {
            return {
              host: entry.host,
              connectionUrl: entry.connectionUrl,
              status: entry.status,
              projects,
              error: entry.error,
            };
          }
          return {
            host: entry.host,
            connectionUrl: entry.connectionUrl,
            status: entry.status,
            projects,
          };
        }
        return null;
      })
      .filter((entry): entry is RemoteSidebarHostEntry => entry !== null);
  }, [activeWsUrl, normalizedProjectSearchQuery, remoteSidebarHosts]);
  const renderedRemoteProjects = useMemo(() => {
    return filteredRemoteSidebarHosts
      .filter((entry) => entry.status === "available")
      .flatMap((entry) =>
        entry.projects.map((project) => {
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
                hiddenThreads: [] as RemoteSidebarThreadEntry[],
                visibleThreads: [] as RemoteSidebarThreadEntry[],
              };
          return {
            project,
            projectKey,
            connectionUrl: entry.connectionUrl,
            projectExpanded,
            visibleThreads: previewThreads,
            hiddenThreadCount: hiddenThreads.length,
            hasHiddenThreads,
            canCollapseThreadList: visibleThreadCount > THREAD_REVEAL_STEP,
          };
        }),
      );
  }, [
    activeRouteConnectionUrl,
    filteredRemoteSidebarHosts,
    remoteProjectExpandedById,
    remoteThreadRevealCountByProject,
    activeThreadId,
  ]);
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
  }, [activeProjects, projectListThreadsByProjectId]);
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
  }, [remoteSidebarHosts]);
  const unifiedRenderedProjects = useMemo(() => {
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
  }, [
    filteredLocalProjectIds,
    projectById,
    sidebarProjectSortOrder,
    renderedRemoteProjects,
    visibleProjectThreadsByProjectId,
  ]);
  const sidebarProjectListItems = useMemo<SidebarProjectListItem[]>(() => {
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
  }, [
    filteredLocalProjectIds,
    isProjectDraggingEnabled,
    localProjectThreadGroupById,
    renderedRemoteProjects,
    unifiedRenderedProjects,
  ]);
  const sidebarProjectListVirtualizer = useVirtualizer({
    count: projectsSectionExpanded ? sidebarProjectListItems.length : 0,
    estimateSize: (index) => estimateSidebarProjectListItemSize(sidebarProjectListItems[index]),
    getItemKey: (index) => sidebarProjectListItems[index]?.key ?? index,
    getScrollElement: () => sidebarContentScrollRef.current,
    overscan: 8,
  });
  const virtualSidebarProjectRows = sidebarProjectListVirtualizer.getVirtualItems();

  useEffect(() => {
    sidebarProjectListVirtualizer.measure();
  }, [
    projectsSectionExpanded,
    sidebarProjectListItems,
    sidebarProjectListVirtualizer,
    sidebarProjectSortOrder,
    sidebarThreadSortOrder,
  ]);

  const hasExpandedVisibleProjects = useMemo(
    () =>
      filteredLocalProjectIds.some((projectId) => {
        const threadGroup = localProjectThreadGroupById.get(projectId);
        return threadGroup?.projectExpanded && threadGroup.renderedThreadIds.length > 0;
      }) ||
      renderedRemoteProjects.some(
        (renderedProject) =>
          renderedProject.projectExpanded && renderedProject.visibleThreads.length > 0,
      ),
    [filteredLocalProjectIds, localProjectThreadGroupById, renderedRemoteProjects],
  );
  const canCollapseVisibleProjects = projectsSectionExpanded && hasExpandedVisibleProjects;
  const collapseVisibleProjects = useCallback(() => {
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
  }, [
    filteredLocalProjectIds,
    localProjectThreadGroupById,
    renderedRemoteProjects,
    setProjectExpanded,
  ]);
  const sortedActiveThreads = useMemo(
    () =>
      Object.values(sidebarThreadsById)
        .filter((thread): thread is SidebarThreadSummary => thread !== undefined)
        .filter((thread) => thread.archivedAt === null)
        .toSorted(
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
        ),
    [sidebarThreadsById],
  );
  const splitPickerAvailableThreadCount = sortedActiveThreads.length;
  const splitPickerThreadOptions = useMemo(() => {
    if (!splitPickerOpen) {
      return [];
    }
    return sortedActiveThreads.map((thread) => ({
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
  }, [projectById, sortedActiveThreads, splitPickerOpen]);
  const splitPickerProjectFilterOptions = useMemo(() => {
    const projectOptions = new Map<string, string>();
    for (const thread of splitPickerThreadOptions) {
      projectOptions.set(thread.projectId, thread.projectName);
    }
    return [...projectOptions.entries()]
      .map(([projectId, projectName]) => ({ projectId, projectName }))
      .toSorted((left, right) => left.projectName.localeCompare(right.projectName));
  }, [splitPickerThreadOptions]);
  const normalizedSplitPickerQuery = splitPickerQuery.trim().toLowerCase();
  const visibleSplitPickerThreadOptions = useMemo(() => {
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
  }, [
    normalizedSplitPickerQuery,
    splitPickerProjectFilter,
    splitPickerSortOrder,
    splitPickerThreadOptions,
  ]);
  const selectedSplitThreadCount = splitPickerSelectedThreadIds.size;
  const openSplitPicker = useCallback(() => {
    setSplitPickerQuery("");
    setSplitPickerProjectFilter("all");
    setSplitPickerSortOrder("recent");
    setSplitPickerSelectedThreadIds(new Set());
    setSplitPickerOpen(true);
  }, []);
  const toggleSplitPickerThread = useCallback((threadId: ThreadId) => {
    setSplitPickerSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);
  const createSelectedSplit = useCallback(() => {
    const selectedTargets = splitPickerThreadOptions
      .filter((thread) => splitPickerSelectedThreadIds.has(thread.id))
      .map((thread) => ({
        connectionUrl: thread.connectionUrl,
        threadId: thread.id,
        title: thread.title ?? null,
      }));
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
    setSplitPickerOpen(false);
    setSplitPickerQuery("");
    setSplitPickerProjectFilter("all");
    setSplitPickerSortOrder("recent");
    setSplitPickerSelectedThreadIds(new Set());
    navigateToBoardThreadRoute(activeTarget);
  }, [
    buildSplitTitle,
    navigateToBoardThreadRoute,
    splitPickerSelectedThreadIds,
    splitPickerThreadOptions,
  ]);
  const sidebarNewThreadProjectId =
    defaultProjectId && projectById.has(defaultProjectId) ? defaultProjectId : null;
  const handleStartNewThreadForProject = useCallback(
    (projectId: ProjectId) => {
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
    },
    [activeDraftThread, activeThread, defaultThreadEnvMode, handleNewThread],
  );
  const handleStartSidebarNewChat = useCallback(() => {
    if (!sidebarNewThreadProjectId) {
      return;
    }
    handleStartNewThreadForProject(sidebarNewThreadProjectId);
  }, [handleStartNewThreadForProject, sidebarNewThreadProjectId]);

  const handleStartNewThreadForRemoteProject = useCallback(
    (input: { connectionUrl: string; project: RemoteSidebarProjectEntry }) => {
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
    },
    [activeDraftThread, activeThread, defaultThreadEnvMode, handleNewThread],
  );
  const {
    searchPaletteOpen,
    searchPaletteMode,
    searchPaletteQuery,
    searchPaletteActiveIndex,
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
    sortedActiveThreads,
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
    onNavigateToThread: navigateToThread,
    onNavigateToThreadOnConnection: navigateToThreadOnConnection,
  });

  const pinnedRenderedThreadGroups = useMemo<
    Array<
      | { kind: "thread"; threadId: ThreadId }
      | { kind: "project"; renderedProject: SidebarLocalProjectThreadGroup }
    >
  >(() => {
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
  }, [localProjectThreadGroupById, sortedRenderedPinnedItems]);
  const renderedSidebarThreadGroups = useMemo(
    () =>
      buildRenderedSidebarThreadGroups<ThreadId, SidebarLocalProjectThreadGroup>({
        pinnedItems: pinnedRenderedThreadGroups,
        renderedProjects: localProjectThreadGroups,
        pinnedSectionExpanded,
      }),
    [localProjectThreadGroups, pinnedRenderedThreadGroups, pinnedSectionExpanded],
  );
  const { visibleSidebarThreadIds, prByThreadId } = useSidebarThreadPrStatus({
    renderedProjects: renderedSidebarThreadGroups,
    sidebarThreadsById,
    projectCwdById,
  });
  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );
  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, threadJumpCommandById]);
  const orderedSidebarThreadIds = visibleSidebarThreadIds;

  useEffect(() => {
    if (!routeThreadId) {
      return;
    }

    const adjacentThreadIds = [
      resolveAdjacentThreadId({
        threadIds: orderedSidebarThreadIds,
        currentThreadId: routeThreadId,
        direction: "previous",
      }),
      resolveAdjacentThreadId({
        threadIds: orderedSidebarThreadIds,
        currentThreadId: routeThreadId,
        direction: "next",
      }),
    ];

    for (const adjacentThreadId of adjacentThreadIds) {
      if (!adjacentThreadId) {
        continue;
      }
      prefetchThreadHistory(adjacentThreadId);
    }
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
        handleStartAddProject();
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
        navigateToThread(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThreadId);
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
    handleStartAddProject,
    isOnSettings,
    navigateToThread,
    openSearchPalette,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    searchPaletteOpen,
    threadJumpThreadIds,
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
        renamingThreadId={renamingThreadId}
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

  function renderLocalProjectItem(
    projectId: ProjectId,
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    return (
      <SidebarLocalProjectSection
        key={projectId}
        projectId={projectId}
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
        isPinned={pinnedProjectIdSet.has(projectId)}
        jumpLabelByThreadId={threadJumpLabelById}
        markProjectContextMenuPending={() => {
          suppressProjectClickForContextMenuRef.current = true;
        }}
        newThreadShortcutLabel={newThreadShortcutLabel}
        onCollapseThreadList={collapseThreadListForProject}
        onExpandThreadList={expandThreadListForProject}
        onTogglePinnedProject={togglePinnedProject}
        onTogglePinnedThread={togglePinnedThread}
        openPrLink={openPrLink}
        pinnedThreadIdSet={pinnedThreadIdSet}
        prByThreadId={prByThreadId}
        prefetchThreadHistory={prefetchThreadHistory}
        renamingCommittedRef={renamingCommittedRef}
        renamingInputRef={renamingInputRef}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        routeThreadId={activeSidebarRouteThreadId}
        selectedThreadIds={selectedThreadIds}
        setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
        setRenamingTitle={setRenamingTitle}
        showThreadJumpHints={showThreadJumpHints}
        threadRevealCount={threadRevealCountByProject[projectId] ?? THREAD_REVEAL_STEP}
        threadSortOrder={sidebarThreadSortOrder}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        navigateToThread={navigateToThread}
      />
    );
  }

  function renderRemoteProjectItem(renderedProject: RenderedRemoteSidebarProject) {
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
                    routeThreadId={activeSidebarRouteThreadId}
                    activeRouteConnectionUrl={activeRouteConnectionUrl}
                    connectionUrl={connectionUrl}
                    selectedThreadIds={selectedThreadIds}
                    showThreadJumpHints={showThreadJumpHints}
                    jumpLabel={null}
                    appSettingsConfirmThreadArchive={confirmThreadArchive}
                    isPinned={false}
                    pinEnabled={false}
                    boardDrag={boardDrag}
                    renamingThreadId={renamingThreadId}
                    renamingTitle={renamingTitle}
                    setRenamingTitle={setRenamingTitle}
                    renamingInputRef={renamingInputRef}
                    renamingCommittedRef={renamingCommittedRef}
                    confirmingArchiveThreadId={confirmingArchiveThreadId}
                    setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
                    confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                    handleThreadClick={handleThreadClick}
                    navigateToThread={(id) => {
                      navigateToThreadOnConnection(connectionUrl, id);
                    }}
                    prefetchThreadHistory={prefetchThreadHistory}
                    handleMultiSelectContextMenu={handleMultiSelectContextMenu}
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
                    clearSelection={clearSelection}
                    commitRename={commitRename}
                    cancelRename={cancelRename}
                    attemptArchiveThread={attemptArchiveThread}
                    onTogglePinnedThread={togglePinnedThread}
                    openPrLink={openPrLink}
                    pr={null}
                  />
                );
              })}

            {projectExpanded && hasHiddenThreads ? (
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuSubButton
                  render={<button type="button" />}
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
                  render={<button type="button" />}
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

  function renderVirtualProjectListItem(virtualRow: VirtualItem) {
    const item = sidebarProjectListItems[virtualRow.index];
    if (!item) {
      return null;
    }
    const virtualStyle = getVirtualProjectRowStyle(virtualRow);
    if (item.kind === "local") {
      if (item.sortable) {
        return (
          <SortableProjectItem
            key={item.key}
            projectId={item.projectId}
            measureElement={sidebarProjectListVirtualizer.measureElement}
            style={virtualStyle}
            virtualIndex={virtualRow.index}
          >
            {(dragHandleProps) => renderLocalProjectItem(item.projectId, dragHandleProps)}
          </SortableProjectItem>
        );
      }
      return (
        <SidebarMenuItem
          key={item.key}
          ref={sidebarProjectListVirtualizer.measureElement}
          className="rounded-md"
          data-index={virtualRow.index}
          style={virtualStyle}
        >
          {renderLocalProjectItem(item.projectId, null)}
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem
        key={item.key}
        ref={sidebarProjectListVirtualizer.measureElement}
        className="rounded-md"
        data-index={virtualRow.index}
        style={virtualStyle}
      >
        {renderRemoteProjectItem(item.renderedProject)}
      </SidebarMenuItem>
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
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
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      startTransition(() => {
        toggleProject(projectId);
      });
    },
    [toggleProject],
  );

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
  }, []);

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

  // Auto-scroll search palette list when navigating with keyboard
  useEffect(() => {
    const listElement = searchPaletteListRef.current;
    if (!listElement || searchPaletteActiveIndex < 0) {
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
  }, [searchPaletteActiveIndex]);

  const handleDesktopUpdateButtonClick = useCallback(() => {
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
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setThreadRevealCountByProject((current) => {
      const nextCount = (current[projectId] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
      return {
        ...current,
        [projectId]: nextCount,
      };
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setThreadRevealCountByProject((current) => {
      if (current[projectId] === undefined) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }, []);

  const toggleRemoteProject = useCallback((projectKey: string) => {
    setRemoteProjectExpandedById((current) => ({
      ...current,
      [projectKey]: !(current[projectKey] ?? true),
    }));
  }, []);

  const expandThreadListForRemoteProject = useCallback((projectKey: string) => {
    setRemoteThreadRevealCountByProject((current) => {
      const nextCount = (current[projectKey] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
      return {
        ...current,
        [projectKey]: nextCount,
      };
    });
  }, []);

  const collapseThreadListForRemoteProject = useCallback((projectKey: string) => {
    setRemoteThreadRevealCountByProject((current) => {
      if (current[projectKey] === undefined) return current;
      const next = { ...current };
      delete next[projectKey];
      return next;
    });
  }, []);

  const sidebarWordmarkLabel = IS_DEV_BUILD ? "acē" : "ace";
  const wordmark = (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="group/sidebar-brand flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/30">
            <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
              {sidebarWordmarkLabel}
            </span>
          </div>
        }
      />
      <TooltipPopup side="bottom" sideOffset={2}>
        Version {APP_VERSION}
      </TooltipPopup>
    </Tooltip>
  );
  const sidebarHeaderToggle = showSidebarHeaderToggle ? (
    <Tooltip>
      <TooltipTrigger render={<SidebarTrigger className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME} />} />
      <TooltipPopup side="bottom" sideOffset={4}>
        {renderSidebarHeaderTooltipContent("Toggle sidebar", sidebarToggleShortcutLabel)}
      </TooltipPopup>
    </Tooltip>
  ) : null;
  const sidebarHeaderNavButtonClassName =
    "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/65 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-40";
  const sidebarHeaderChrome = (
    <div ref={sidebarHeaderRowRef} className="flex h-7 min-w-0 items-center gap-2">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          isElectron && "pl-[max(0px,calc(var(--desktop-titlebar-left-inset)-0.875rem))]",
        )}
      >
        {sidebarHeaderToggle}
        <div className="min-w-0">{wordmark}</div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={sidebarHeaderNavButtonClassName}
                aria-label="Go back"
                onClick={() => window.history.back()}
              >
                <ChevronLeftIcon className="size-4.5" strokeWidth={2.25} />
              </button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            {renderSidebarHeaderTooltipContent("Back", navigationBackShortcutLabel)}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={sidebarHeaderNavButtonClassName}
                aria-label="Go forward"
                onClick={() => window.history.forward()}
              >
                <ChevronRightIcon className="size-4.5" strokeWidth={2.25} />
              </button>
            }
          />
          <TooltipPopup side="bottom" sideOffset={4}>
            {renderSidebarHeaderTooltipContent("Forward", navigationForwardShortcutLabel)}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );

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
            <DialogDescription>
              Rename the project and choose a favicon or custom icon.
            </DialogDescription>
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
                    autoFocus
                    value={editingProjectName}
                    onChange={(event) => setEditingProjectName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Icon</p>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      className={`flex flex-col items-center gap-2 rounded-md border px-2 py-3 text-xs ${
                        editingProjectIcon === null
                          ? "border-primary/50 bg-primary/8"
                          : "border-border/50 hover:bg-accent/40"
                      }`}
                      onClick={() => setEditingProjectIcon(null)}
                    >
                      <ProjectAvatar
                        project={{
                          cwd: editingProjectTarget.cwd,
                          icon: null,
                        }}
                        className="size-5"
                      />
                      <span>Favicon</span>
                    </button>
                    {PROJECT_ICON_OPTIONS.map((option) => {
                      const previewIcon = {
                        glyph: option.glyph,
                        color: editingProjectIcon?.color ?? "blue",
                      } as const;
                      const isSelected = editingProjectIcon?.glyph === option.glyph;
                      return (
                        <button
                          key={option.glyph}
                          type="button"
                          className={`flex flex-col items-center gap-2 rounded-md border px-2 py-3 text-xs ${
                            isSelected
                              ? "border-primary/50 bg-primary/8"
                              : "border-border/50 hover:bg-accent/40"
                          }`}
                          onClick={() => setEditingProjectIcon(previewIcon)}
                        >
                          <ProjectGlyphIcon icon={previewIcon} className="size-5" />
                          <span>{option.label}</span>
                        </button>
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
                          <button
                            key={option.color}
                            type="button"
                            className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs ${
                              isSelected
                                ? "border-primary/50 bg-primary/8"
                                : "border-border/50 hover:bg-accent/40"
                            }`}
                            onClick={() =>
                              setEditingProjectIcon((current) =>
                                current === null ? current : { ...current, color: option.color },
                              )
                            }
                          >
                            <span className={`size-3 rounded-full ${option.swatchClassName}`} />
                            <span>{option.label}</span>
                          </button>
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
      <Dialog
        open={remoteThreadRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeRemoteThreadRenameDialog();
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
            <DialogDescription>
              {remoteThreadRenameTarget
                ? `Update the thread title in ${remoteThreadRenameTarget.project.name}.`
                : "Update the thread title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Thread title</p>
              <Input
                autoFocus
                value={remoteThreadRenameTitle}
                onChange={(event) => setRemoteThreadRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  void saveRemoteThreadRename();
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeRemoteThreadRenameDialog}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveRemoteThreadRename()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
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
          setSplitPickerOpen(open);
          if (!open) {
            setSplitPickerQuery("");
            setSplitPickerProjectFilter("all");
            setSplitPickerSortOrder("recent");
            setSplitPickerSelectedThreadIds(new Set());
          }
        }}
        onQueryChange={setSplitPickerQuery}
        onProjectFilterChange={setSplitPickerProjectFilter}
        onSortOrderChange={setSplitPickerSortOrder}
        onToggleThread={toggleSplitPickerThread}
        onCancel={() => {
          setSplitPickerOpen(false);
          setSplitPickerQuery("");
          setSplitPickerProjectFilter("all");
          setSplitPickerSortOrder("recent");
          setSplitPickerSelectedThreadIds(new Set());
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
              <button
                type="button"
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
          setAddingProject(open);
          if (!open) {
            setAddProjectError(null);
            setProjectPickerStep("environment");
            setProjectPickerEnvironmentQuery("");
            setProjectPickerSelectedConnectionUrl(null);
            setProjectPickerEnvironmentProbeId(null);
          }
        }}
      >
        <CommandDialogPopup className="flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden border border-border/50 bg-popover/98 p-0  rounded-xl">
          <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3 bg-gradient-to-b from-popover/50 to-popover/20">
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-accent/80 hover:text-foreground active:scale-95 disabled:opacity-50"
              onClick={() => {
                if (projectPickerStep === "environment") {
                  setAddingProject(false);
                  setAddProjectError(null);
                  setProjectPickerEnvironmentProbeId(null);
                  return;
                }
                if (pickerEnvironments.length > 1) {
                  setProjectPickerStep("environment");
                  setProjectPickerEnvironmentQuery("");
                  setActiveProjectBrowseIndex(0);
                  return;
                }
                handleBrowseParentPath();
              }}
              disabled={isAddingProject || isBrowsingProjectPaths}
              aria-label={
                projectPickerStep === "environment"
                  ? "Close project picker"
                  : pickerEnvironments.length > 1
                    ? "Back to environments"
                    : "Browse parent directory"
              }
            >
              <ChevronLeftIcon className="size-5" strokeWidth={2.5} />
            </button>
            <input
              ref={addProjectInputRef}
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
                  setProjectPickerEnvironmentQuery(event.target.value);
                } else {
                  setNewCwd(event.target.value);
                }
                setAddProjectError(null);
              }}
              onKeyDown={handleAddProjectInputKeyDown}
              autoFocus
            />
            {projectPickerStep === "directory" ? (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 disabled:opacity-60"
                onClick={handleAddProject}
                disabled={!canAddProject}
              >
                <span>{addProjectActionLabel}</span>
                <span className="rounded border border-primary-foreground/30 bg-primary-foreground/15 px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground/90">
                  Enter
                </span>
              </button>
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
              <div ref={projectPickerListRef} className="min-h-0 flex-1 overflow-y-auto">
                {projectPickerStep === "environment" ? (
                  filteredPickerEnvironments.length > 0 ? (
                    filteredPickerEnvironments.map((environment, index) => (
                      <button
                        key={environment.id}
                        type="button"
                        data-project-picker-environment-index={index}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-all duration-150 border-b border-border/20 last:border-b-0 ${
                          index === activeProjectBrowseIndex
                            ? "bg-primary/15 text-foreground"
                            : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                        }`}
                        onMouseEnter={() => {
                          if (Date.now() - lastKeyboardNavigationTimeRef.current > 500) {
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
                      </button>
                    ))
                  ) : (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                      No matching environments
                    </p>
                  )
                ) : isBrowsingProjectPaths || isWaitingForCurrentProjectBrowse ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                    Browsing directories...
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 border-border/20 border-b px-4 py-2.5 text-left text-sm font-medium text-muted-foreground/70 transition-all hover:bg-accent/40 hover:text-foreground"
                      onClick={handleBrowseParentPath}
                      disabled={isAddingProject}
                    >
                      <ArrowUpIcon className="size-4" strokeWidth={2} />
                      <span className="font-semibold">..</span>
                    </button>
                    {currentProjectBrowseResult?.entries.length ? (
                      currentProjectBrowseResult.entries.map((entry, index) => (
                        <button
                          key={entry.fullPath}
                          type="button"
                          data-project-picker-index={index}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-all duration-150 border-b border-border/20 last:border-b-0 ${
                            index === activeProjectBrowseIndex
                              ? "bg-primary/15 text-foreground"
                              : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onMouseEnter={() => {
                            if (Date.now() - lastKeyboardNavigationTimeRef.current > 500) {
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
                        </button>
                      ))
                    ) : (
                      <p className="px-4 py-6 text-center text-sm text-muted-foreground/60">
                        No directories found
                      </p>
                    )}
                  </>
                )}
              </div>
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

      {isElectron ? (
        <SidebarHeader className={cn("drag-region", DESKTOP_HEADER_CHROME_CLASS_NAME)}>
          {sidebarHeaderChrome}
        </SidebarHeader>
      ) : (
        <SidebarHeader className={DESKTOP_HEADER_CHROME_CLASS_NAME}>
          {sidebarHeaderChrome}
        </SidebarHeader>
      )}

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
            <SidebarGroup className="px-2 pt-2 pb-0">
              <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
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
              <button
                type="button"
                className="group/sidebar-new-chat flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
                onClick={handleStartSidebarNewChat}
                disabled={!sidebarNewThreadProjectId}
                aria-label="New chat"
              >
                <SquarePenIcon className="size-3.5 shrink-0 transition-colors group-hover/sidebar-new-chat:text-sidebar-accent-foreground" />
                <span className="min-w-0 flex-1 truncate">New chat</span>
              </button>
              <button
                type="button"
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
              </button>
            </div>
          </SidebarGroup>
          <SidebarContent ref={sidebarContentScrollRef} className="gap-0 pt-1.5">
            {sortedRenderedPinnedItems.length > 0 ? (
              <SidebarGroup className="px-2.5 pt-5 pb-2">
                <button
                  type="button"
                  className="group/section-header mb-1.5 flex h-5 w-full cursor-pointer items-center gap-1.5 bg-transparent pl-2 pr-1.5 text-left"
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
                            {renderLocalProjectItem(item.projectId, null)}
                          </SidebarMenuItem>
                        ),
                      )}
                    </SidebarMenuSub>
                  </div>
                </div>
              </SidebarGroup>
            ) : null}
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
            <SidebarGroup className="px-2.5 pt-2.5 pb-5">
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
                      collisionDetection={projectCollisionDetection}
                      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                      onDragStart={handleProjectDragStart}
                      onDragEnd={handleProjectDragEnd}
                      onDragCancel={handleProjectDragCancel}
                    >
                      <SidebarMenu
                        className="relative gap-0"
                        style={{ height: `${sidebarProjectListVirtualizer.getTotalSize()}px` }}
                      >
                        <SortableContext
                          items={filteredLocalProjectIds}
                          strategy={verticalListSortingStrategy}
                        >
                          {virtualSidebarProjectRows.map((virtualRow) =>
                            renderVirtualProjectListItem(virtualRow),
                          )}
                        </SortableContext>
                      </SidebarMenu>
                    </DndContext>
                  ) : (
                    <SidebarMenu
                      className="relative gap-0"
                      style={{ height: `${sidebarProjectListVirtualizer.getTotalSize()}px` }}
                    >
                      {virtualSidebarProjectRows.map((virtualRow) =>
                        renderVirtualProjectListItem(virtualRow),
                      )}
                    </SidebarMenu>
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
