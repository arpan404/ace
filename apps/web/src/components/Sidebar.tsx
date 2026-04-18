import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  LaptopIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
  ChevronLeftIcon,
} from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  type FilesystemBrowseResult,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@ace/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type SidebarThreadSortOrder } from "@ace/contracts/settings";
import { isElectron } from "../env";
import { APP_BASE_NAME, APP_VERSION, IS_DEV_BUILD } from "../branding";
import { reportBackgroundError } from "../lib/async";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import { MAC_TITLEBAR_LEFT_INSET_STYLE } from "../lib/desktopChrome";
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

import { useThreadActions } from "../hooks/useThreadActions";
import {
  ProjectAvatar,
  ProjectGlyphIcon,
  PROJECT_ICON_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
} from "./ProjectAvatar";
import { toastManager } from "./ui/toast";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
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
import { Badge } from "./ui/badge";
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
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadOptions,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../lib/sidebar";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { ProjectSortMenu } from "./sidebar/ProjectSortMenu";
import {
  SortableProjectItem,
  type SortableProjectHandleProps,
} from "./sidebar/SortableProjectItem";
import { SidebarThreadRow, ThreadStatusLabel } from "./sidebar/SidebarThreadRow";
import { useSidebarCommandPalette } from "./sidebar/useSidebarCommandPalette";
import { useSidebarThreadPrStatus } from "./sidebar/useSidebarThreadPrStatus";
import type {
  RemoteSidebarHostEntry,
  RemoteSidebarProjectEntry,
  RemoteSidebarThreadEntry,
} from "./sidebar/sidebarTypes";
import { prefetchHydratedThread, readCachedHydratedThread } from "../lib/threadHydrationCache";
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
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import type { Project, SidebarThreadSummary } from "../types";
import { useHostConnectionStore } from "../hostConnectionStore";
import { THREAD_ROUTE_CONNECTION_SEARCH_PARAM } from "../lib/connectionRouting";
const THREAD_REVEAL_STEP = 5;
const REMOTE_HOST_REFRESH_INTERVAL_MS = 6_000;
const REMOTE_HOST_INITIAL_RESOLVE_DELAY_MS = 1_500;
const EMPTY_SIDEBAR_THREADS: SidebarThreadSummary[] = [];
const sortedSidebarThreadsCache = new WeakMap<
  ReadonlyArray<SidebarThreadSummary>,
  Map<SidebarThreadSortOrder, SidebarThreadSummary[]>
>();
const threadStatusCache = new WeakMap<
  SidebarThreadSummary,
  Map<string, ReturnType<typeof resolveThreadStatusPill>>
>();
const projectStatusCache = new WeakMap<
  Record<string, string>,
  WeakMap<ReadonlyArray<SidebarThreadSummary>, ReturnType<typeof resolveProjectStatusIndicator>>
>();
const hiddenThreadStatusCache = new WeakMap<
  Record<string, string>,
  WeakMap<
    ReadonlyArray<SidebarThreadSummary>,
    Map<string, ReturnType<typeof resolveProjectStatusIndicator>>
  >
>();
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

function getCachedSortedSidebarThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  sortOrder: SidebarThreadSortOrder,
): SidebarThreadSummary[] {
  let cacheBySortOrder = sortedSidebarThreadsCache.get(threads);
  if (!cacheBySortOrder) {
    cacheBySortOrder = new Map();
    sortedSidebarThreadsCache.set(threads, cacheBySortOrder);
  }

  const cachedThreads = cacheBySortOrder.get(sortOrder);
  if (cachedThreads) {
    return cachedThreads;
  }

  const sortedThreads = sortThreadsForSidebar(threads, sortOrder);
  cacheBySortOrder.set(sortOrder, sortedThreads);
  return sortedThreads;
}

function getCachedThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
): ReturnType<typeof resolveThreadStatusPill> {
  let cacheByVisitedAt = threadStatusCache.get(thread);
  if (!cacheByVisitedAt) {
    cacheByVisitedAt = new Map();
    threadStatusCache.set(thread, cacheByVisitedAt);
  }

  const cacheKey = lastVisitedAt ?? "";
  if (cacheByVisitedAt.has(cacheKey)) {
    return cacheByVisitedAt.get(cacheKey) ?? null;
  }

  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  cacheByVisitedAt.set(cacheKey, status);
  return status;
}

function getCachedProjectStatus(
  threads: ReadonlyArray<SidebarThreadSummary>,
  threadLastVisitedAtById: Record<string, string>,
): ReturnType<typeof resolveProjectStatusIndicator> {
  let cacheByThreads = projectStatusCache.get(threadLastVisitedAtById);
  if (!cacheByThreads) {
    cacheByThreads = new WeakMap();
    projectStatusCache.set(threadLastVisitedAtById, cacheByThreads);
  }

  if (cacheByThreads.has(threads)) {
    return cacheByThreads.get(threads) ?? null;
  }

  const status = resolveProjectStatusIndicator(
    threads.map((thread) => getCachedThreadStatus(thread, threadLastVisitedAtById[thread.id])),
  );
  cacheByThreads.set(threads, status);
  return status;
}

function getCachedHiddenThreadStatus(input: {
  activeThreadId: ThreadId | undefined;
  visibleCount: number;
  threadLastVisitedAtById: Record<string, string>;
  threads: ReadonlyArray<SidebarThreadSummary>;
}): ReturnType<typeof resolveProjectStatusIndicator> {
  if (input.threads.length <= input.visibleCount) {
    return null;
  }

  let cacheByThreads = hiddenThreadStatusCache.get(input.threadLastVisitedAtById);
  if (!cacheByThreads) {
    cacheByThreads = new WeakMap();
    hiddenThreadStatusCache.set(input.threadLastVisitedAtById, cacheByThreads);
  }

  let cacheByKey = cacheByThreads.get(input.threads);
  if (!cacheByKey) {
    cacheByKey = new Map();
    cacheByThreads.set(input.threads, cacheByKey);
  }

  const cacheKey = `${input.activeThreadId ?? ""}:${input.visibleCount}`;
  if (cacheByKey.has(cacheKey)) {
    return cacheByKey.get(cacheKey) ?? null;
  }

  const { hiddenThreads } = getVisibleThreadsForProject({
    threads: input.threads,
    activeThreadId: input.activeThreadId,
    visibleCount: input.visibleCount,
  });
  const status = resolveProjectStatusIndicator(
    hiddenThreads.map((thread) =>
      getCachedThreadStatus(thread, input.threadLastVisitedAtById[thread.id]),
    ),
  );
  cacheByKey.set(cacheKey, status);
  return status;
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

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder, threadLastVisitedAtById } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      threadLastVisitedAtById: store.threadLastVisitedAtById,
    })),
  );
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const locationSearch = useLocation({ select: (loc) => loc.searchStr });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();
  const { archiveThread, deleteThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
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
  const [activeProjectBrowseIndex, setActiveProjectBrowseIndex] = useState(-1);
  const lastKeyboardNavigationTimeRef = useRef(0);
  const [projectPickerEnvironmentProbeId, setProjectPickerEnvironmentProbeId] = useState<
    string | null
  >(null);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const projectPickerListRef = useRef<HTMLDivElement | null>(null);
  const searchPaletteListRef = useRef<HTMLDivElement | null>(null);
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
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<ThreadId, HTMLButtonElement>());
  const sidebarHeaderRowRef = useRef<HTMLDivElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [isSidebarHeaderCompact, setIsSidebarHeaderCompact] = useState(false);
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
  const [remoteSidebarHosts, setRemoteSidebarHosts] = useState<
    ReadonlyArray<RemoteSidebarHostEntry>
  >(() => remoteSidebarHostSnapshotCache);
  const remoteSidebarHostsRef = useRef<ReadonlyArray<RemoteSidebarHostEntry>>(
    remoteSidebarHostSnapshotCache,
  );
  const registeredRemoteRouteConnectionUrlsRef = useRef<Set<string>>(new Set());
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
  const pickerEnvironments = useMemo((): ProjectPickerEnvironment[] => {
    const uniqueByConnection = new Map<string, ProjectPickerEnvironment>();
    const connectedHostIds = new Set(projectPickerConnectedHostIds);

    uniqueByConnection.set(localDeviceConnectionUrl, {
      id: "local-device",
      name: "This device",
      subtitle: localDeviceHost.wsUrl,
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
      uniqueByConnection.set(connectionUrl, {
        id: host.id,
        name: host.name,
        subtitle: host.wsUrl,
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
    localDeviceHost.wsUrl,
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
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
    clearPromotedDraftThreads(threads.map((thread) => thread.id));
  }, []);
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
        reconcileThreadDerivedState();
        setRemoteSidebarHosts((current) => (current.length === 0 ? current : []));
        return;
      }

      const previousEntriesByConnectionUrl = new Map(
        remoteSidebarHostsRef.current.map((entry) => [entry.connectionUrl, entry] as const),
      );
      const hostEntries = await Promise.all(
        hosts.map(async (host): Promise<RemoteSidebarHostEntry> => {
          const connectionUrl = resolveHostConnectionWsUrl(host);
          const previousEntry = previousEntriesByConnectionUrl.get(connectionUrl);
          try {
            const snapshot = (await routeOrchestrationGetSnapshotFromRemote(
              connectionUrl,
              LEAN_SNAPSHOT_RECOVERY_INPUT,
            )) as OrchestrationReadModel;
            useHostConnectionStore.getState().upsertSnapshotOwnership(connectionUrl, snapshot);
            useStore.getState().mergeServerReadModel(snapshot, {
              ...LEAN_SNAPSHOT_RECOVERY_INPUT,
              connectionUrl,
            });
            const mappedProjects = mapRemoteProjectsFromSnapshot(
              snapshot,
              appSettings.sidebarProjectSortOrder,
            );
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
        }),
      );
      reconcileThreadDerivedState();

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
  }, [appSettings.sidebarProjectSortOrder, localDeviceConnectionUrl, reconcileThreadDerivedState]);
  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }
    let cancelled = false;
    let timeoutHandle: number | null = null;

    const schedule = (delayMs = REMOTE_HOST_REFRESH_INTERVAL_MS) => {
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
        schedule();
      }
    };

    schedule(REMOTE_HOST_INITIAL_RESOLVE_DELAY_MS);
    return () => {
      cancelled = true;
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
      for (const connectionUrl of registeredRemoteRouteConnectionUrlsRef.current) {
        unregisterRemoteRoute(connectionUrl);
      }
      registeredRemoteRouteConnectionUrlsRef.current.clear();
    };
  }, [bootstrapComplete, refreshRemoteSidebarHosts]);
  const addProjectBaseDirectory = useMemo(() => {
    const configuredBaseDirectory = appSettings.addProjectBaseDirectory.trim();
    return configuredBaseDirectory.length > 0 ? configuredBaseDirectory : "~";
  }, [appSettings.addProjectBaseDirectory]);
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
      const latestThread = sortThreadsForSidebar(
        (threadIdsByProjectId[projectId] ?? [])
          .map((threadId) => sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, sidebarThreadsById, threadIdsByProjectId],
  );

  const refreshProjectBrowse = useCallback(
    async (partialPath: string) => {
      const trimmedPath = partialPath.trim();
      if (!addingProject || projectPickerStep !== "directory" || !trimmedPath) {
        setProjectBrowseResult(null);
        setActiveProjectBrowseIndex(-1);
        return;
      }

      const requestVersion = browseRequestVersionRef.current + 1;
      browseRequestVersionRef.current = requestVersion;
      setIsBrowsingProjectPaths(true);
      try {
        const targetEnvironment = selectedProjectPickerEnvironment;
        const targetConnectionUrl = targetEnvironment?.connectionUrl ?? localDeviceConnectionUrl;
        const browseResult = await routeFilesystemBrowseToRemote(targetConnectionUrl, {
          partialPath: trimmedPath,
        });
        if (browseRequestVersionRef.current !== requestVersion) {
          return;
        }
        setProjectBrowseResult(browseResult);
        setActiveProjectBrowseIndex(browseResult.entries.length > 0 ? 0 : -1);
      } catch (error) {
        if (browseRequestVersionRef.current !== requestVersion) {
          return;
        }
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
    [addingProject, localDeviceConnectionUrl, projectPickerStep, selectedProjectPickerEnvironment],
  );

  useEffect(() => {
    if (!addingProject || projectPickerStep !== "directory") {
      setProjectBrowseResult(null);
      setActiveProjectBrowseIndex(-1);
      setIsBrowsingProjectPaths(false);
      return;
    }
    const trimmedPath = newCwd.trim();
    if (!trimmedPath) {
      setProjectBrowseResult(null);
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
      const targetEnvironment = selectedProjectPickerEnvironment;
      const isLocalEnvironment = targetEnvironment?.isLocal ?? true;
      const targetConnectionUrl = targetEnvironment?.connectionUrl ?? localDeviceConnectionUrl;
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
        await routeOrchestrationDispatchCommandToRemote(targetConnectionUrl, {
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        finishAddingProject();
        refreshRemoteSidebarHosts().catch(() => undefined);
        if (!isLocalEnvironment) {
          toastManager.add({
            type: "success",
            title: `Added project on ${targetEnvironment?.name ?? "remote host"}.`,
          });
        } else {
          handleNewThread(projectId, {
            envMode: appSettings.defaultThreadEnvMode,
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
      appSettings.defaultThreadEnvMode,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      localDeviceConnectionUrl,
      projects,
      refreshRemoteSidebarHosts,
      selectedProjectPickerEnvironment,
    ],
  );

  const handleAddProject = useCallback(() => {
    void addProjectFromPath(newCwd);
  }, [addProjectFromPath, newCwd]);

  const handleBrowseProjectEntry = useCallback((fullPath: string) => {
    setAddProjectError(null);
    setNewCwd(toBrowseDirectoryPath(fullPath));
  }, []);

  const handleBrowseParentPath = useCallback(() => {
    const currentPath = projectBrowseResult?.parentPath ?? newCwd.trim();
    if (!currentPath) {
      return;
    }
    const nextPath = parentPath(currentPath);
    if (!nextPath || nextPath === currentPath) {
      return;
    }
    setNewCwd(toBrowseDirectoryPath(nextPath));
    setAddProjectError(null);
  }, [newCwd, projectBrowseResult]);

  const canAddProject =
    projectPickerStep === "directory" && newCwd.trim().length > 0 && !isAddingProject;
  const normalizedResolvedProjectPath = useMemo(() => {
    const shouldResolveAsLocal = selectedProjectPickerEnvironment?.isLocal ?? true;
    return resolveProjectPath(newCwd, shouldResolveAsLocal ? addProjectBaseDirectory : undefined)
      .trim()
      .toLowerCase();
  }, [addProjectBaseDirectory, newCwd, selectedProjectPickerEnvironment]);
  const isBrowsePathExactDirectoryMatch = useMemo(() => {
    const trimmedPath = newCwd.trim();
    if (!trimmedPath) {
      return false;
    }
    if (/[\\/]$/.test(trimmedPath) || trimmedPath === "~") {
      return true;
    }
    return (
      projectBrowseResult?.entries.some(
        (entry) => entry.fullPath.trim().toLowerCase() === normalizedResolvedProjectPath,
      ) ?? false
    );
  }, [newCwd, normalizedResolvedProjectPath, projectBrowseResult]);
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
          const entryCount = projectBrowseResult?.entries.length ?? 0;
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
          const entryCount = projectBrowseResult?.entries.length ?? 0;
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
            ? projectBrowseResult?.entries[activeProjectBrowseIndex]
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
      projectBrowseResult,
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
        : (projectBrowseResult?.entries.length ?? 0);
    setActiveProjectBrowseIndex((currentIndex) => {
      if (itemCount === 0) {
        return -1;
      }
      if (currentIndex < 0) {
        return 0;
      }
      return Math.min(currentIndex, itemCount - 1);
    });
  }, [addingProject, filteredPickerEnvironments.length, projectBrowseResult, projectPickerStep]);

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
      const thread = sidebarThreadsById[threadId];
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

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
      if (appSettings.confirmThreadDelete) {
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
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      projectCwdById,
      sidebarThreadsById,
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
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = sidebarThreadsById[id];
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
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
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      sidebarThreadsById,
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
      const thread = sidebarThreadsById[threadId];
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
        const threadRouteSearch = connectionUrlsEqual(connectionUrl, localDeviceConnectionUrl)
          ? {}
          : { [THREAD_ROUTE_CONNECTION_SEARCH_PARAM]: connectionUrl };
        void navigate({
          to: "/$threadId",
          params: { threadId },
          search: threadRouteSearch,
        });
      });
    },
    [
      clearSelection,
      localDeviceConnectionUrl,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      sidebarThreadsById,
      toggleThreadSelection,
    ],
  );

  const prefetchThreadHistory = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
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
    [sidebarThreadsById],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
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
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          search: {},
        });
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor, sidebarThreadsById],
  );
  const navigateToThreadOnConnection = useCallback(
    (connectionUrl: string, threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      useHostConnectionStore.getState().upsertThreadOwnership(connectionUrl, threadId);
      const thread = sidebarThreadsById[threadId];
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
          search: {
            [THREAD_ROUTE_CONNECTION_SEARCH_PARAM]: connectionUrl,
          },
        });
      });
    },
    [
      clearSelection,
      localDeviceConnectionUrl,
      navigate,
      navigateToThread,
      selectedThreadIds.size,
      setSelectionAnchor,
      sidebarThreadsById,
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
          { id: "edit", label: "Edit project" },
          { id: "copy-path", label: "Copy Project Path" },
          { id: "archive", label: "Archive project" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
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
      projects,
      setEditingProjectIcon,
      setEditingProjectConnectionUrl,
      setEditingProjectId,
      setEditingProjectName,
      setProjectEditorOpen,
      threadIdsByProjectId,
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
          { id: "rename", label: "Rename thread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "archive", label: "Archive thread" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

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
      if (appSettings.confirmThreadDelete) {
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
      appSettings.confirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
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
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = orderedProjects.find((project) => project.id === active.id);
      const overProject = orderedProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, orderedProjects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

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

  const activeThreadId = routeThreadId ?? undefined;
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
  const sortedProjects = useMemo(() => {
    if (appSettings.sidebarProjectSortOrder === "manual") {
      return orderedProjects;
    }

    const sortOrder = appSettings.sidebarProjectSortOrder;
    return [...orderedProjects].toSorted((left, right) => {
      const rightTimestamp = getProjectSortTimestamp(
        right,
        visibleProjectThreadsByProjectId.get(right.id) ?? EMPTY_SIDEBAR_THREADS,
        sortOrder,
      );
      const leftTimestamp = getProjectSortTimestamp(
        left,
        visibleProjectThreadsByProjectId.get(left.id) ?? EMPTY_SIDEBAR_THREADS,
        sortOrder,
      );
      const byTimestamp =
        rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
  }, [appSettings.sidebarProjectSortOrder, orderedProjects, visibleProjectThreadsByProjectId]);
  const isManualProjectSorting =
    appSettings.sidebarProjectSortOrder === "manual" && normalizedProjectSearchQuery.length === 0;
  const renderedProjects = useMemo(
    () =>
      sortedProjects.map((project) => {
        const unsortedProjectThreads =
          visibleProjectThreadsByProjectId.get(project.id) ?? EMPTY_SIDEBAR_THREADS;
        const projectExpanded = projectExpandedById[project.id] ?? true;
        const projectStatus = getCachedProjectStatus(
          unsortedProjectThreads,
          threadLastVisitedAtById,
        );
        const visibleThreadCount = threadRevealCountByProject[project.id] ?? THREAD_REVEAL_STEP;
        const shouldShowThreadPanel =
          projectExpanded ||
          (activeThreadId !== undefined &&
            unsortedProjectThreads.some((thread) => thread.id === activeThreadId));
        const projectThreads = shouldShowThreadPanel
          ? getCachedSortedSidebarThreads(
              unsortedProjectThreads,
              appSettings.sidebarThreadSortOrder,
            )
          : EMPTY_SIDEBAR_THREADS;
        const pinnedCollapsedThread =
          !projectExpanded && activeThreadId
            ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
            : null;
        const {
          hasHiddenThreads,
          hiddenThreads,
          visibleThreads: visibleProjectThreads,
        } = shouldShowThreadPanel
          ? getVisibleThreadsForProject({
              threads: projectThreads,
              activeThreadId,
              visibleCount: visibleThreadCount,
            })
          : {
              hasHiddenThreads: false,
              hiddenThreads: EMPTY_SIDEBAR_THREADS,
              visibleThreads: EMPTY_SIDEBAR_THREADS,
            };
        const hiddenThreadStatus =
          projectExpanded && hasHiddenThreads
            ? getCachedHiddenThreadStatus({
                activeThreadId,
                visibleCount: visibleThreadCount,
                threadLastVisitedAtById,
                threads: projectThreads,
              })
            : null;
        const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
        const renderedThreadIds = pinnedCollapsedThread
          ? [pinnedCollapsedThread.id]
          : visibleProjectThreads.map((thread) => thread.id);
        const showEmptyThreadState = projectExpanded && projectThreads.length === 0;

        return {
          hasHiddenThreads,
          hiddenThreadCount: hiddenThreads.length,
          hiddenThreadStatus,
          projectExpanded,
          orderedProjectThreadIds,
          project,
          projectStatus,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel,
          canCollapseThreadList: visibleThreadCount > THREAD_REVEAL_STEP,
          connectionUrl: activeWsUrl,
        };
      }),
    [
      activeWsUrl,
      appSettings.sidebarThreadSortOrder,
      threadRevealCountByProject,
      projectExpandedById,
      sortedProjects,
      activeThreadId,
      threadLastVisitedAtById,
      visibleProjectThreadsByProjectId,
    ],
  );
  const filteredRenderedProjects = useMemo(() => {
    if (normalizedProjectSearchQuery.length === 0) {
      return renderedProjects;
    }
    return renderedProjects.filter((renderedProject) => {
      const { project } = renderedProject;
      if (
        project.name.toLowerCase().includes(normalizedProjectSearchQuery) ||
        project.cwd.toLowerCase().includes(normalizedProjectSearchQuery)
      ) {
        return true;
      }
      const projectThreads =
        visibleProjectThreadsByProjectId.get(project.id) ?? EMPTY_SIDEBAR_THREADS;
      return projectThreads.some((thread) =>
        thread.title.toLowerCase().includes(normalizedProjectSearchQuery),
      );
    });
  }, [normalizedProjectSearchQuery, renderedProjects, visibleProjectThreadsByProjectId]);
  const filteredRemoteSidebarHosts = useMemo(() => {
    const visibleRemoteSidebarHosts = remoteSidebarHosts.filter(
      (entry) => !isHostConnectionActive(entry.host, activeWsUrl),
    );
    if (normalizedProjectSearchQuery.length === 0) {
      return visibleRemoteSidebarHosts;
    }
    return visibleRemoteSidebarHosts
      .map((entry) => {
        const hostMatches =
          entry.host.name.toLowerCase().includes(normalizedProjectSearchQuery) ||
          entry.host.wsUrl.toLowerCase().includes(normalizedProjectSearchQuery);
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
            ? (routeThreadId ?? undefined)
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
    routeThreadId,
  ]);
  const unifiedRenderedProjects = useMemo(() => {
    const localProjects = filteredRenderedProjects.map((project) => ({
      kind: "local" as const,
      key: `local:${project.project.id}`,
      timestamp: getProjectSortTimestamp(
        project.project,
        visibleProjectThreadsByProjectId.get(project.project.id) ?? EMPTY_SIDEBAR_THREADS,
        appSettings.sidebarProjectSortOrder === "created_at" ? "created_at" : "updated_at",
      ),
      projectName: project.project.name,
      projectId: project.project.id,
      payload: project,
    }));
    const remoteProjects = renderedRemoteProjects.map((project) => {
      const timestamp =
        appSettings.sidebarProjectSortOrder === "created_at"
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
    appSettings.sidebarProjectSortOrder,
    filteredRenderedProjects,
    renderedRemoteProjects,
    visibleProjectThreadsByProjectId,
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
  const handleStartNewThreadForProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(
        projectId,
        resolveSidebarNewThreadOptions({
          projectId,
          defaultEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
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
    [activeDraftThread, activeThread, appSettings.defaultThreadEnvMode, handleNewThread],
  );

  const handleStartNewThreadForRemoteProject = useCallback(
    (input: { connectionUrl: string; project: RemoteSidebarProjectEntry }) => {
      void handleNewThread(input.project.id, {
        ...resolveSidebarNewThreadOptions({
          projectId: input.project.id,
          defaultEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
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
    [activeDraftThread, activeThread, appSettings.defaultThreadEnvMode, handleNewThread],
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
    threadIdsByProjectId,
    projectSortOrder: appSettings.sidebarProjectSortOrder,
    threadSortOrder: appSettings.sidebarThreadSortOrder,
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

  const { visibleSidebarThreadIds, prByThreadId } = useSidebarThreadPrStatus({
    renderedProjects: filteredRenderedProjects,
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

  function renderProjectItem(
    renderedProject: (typeof renderedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const {
      hasHiddenThreads,
      hiddenThreadCount,
      hiddenThreadStatus,
      projectExpanded,
      orderedProjectThreadIds,
      project,
      projectStatus,
      renderedThreadIds,
      showEmptyThreadState,
      shouldShowThreadPanel,
      canCollapseThreadList,
      connectionUrl,
    } = renderedProject;
    return (
      <>
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={`gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent group-hover/project-header:bg-accent ${
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            }`}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
            onPointerDownCapture={handleProjectTitlePointerDownCapture}
            onClick={(event) => handleProjectTitleClick(event, project.id)}
            onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              suppressProjectClickForContextMenuRef.current = true;
              void handleProjectContextMenu(project.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {!projectExpanded && projectStatus ? (
              <span
                aria-hidden="true"
                title={projectStatus.label}
                className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </span>
            ) : (
              <ChevronRightIcon
                className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                  projectExpanded ? "rotate-90" : ""
                }`}
              />
            )}
            <ProjectAvatar project={project} />
            <span className="flex-1 truncate text-xs font-medium text-foreground">
              {project.name}
            </span>
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
                  className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleStartNewThreadForProject(project.id);
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

        <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0.5">
          {shouldShowThreadPanel && showEmptyThreadState ? (
            <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
              <div
                data-thread-selection-safe
                className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
              >
                <span>No threads yet</span>
              </div>
            </SidebarMenuSubItem>
          ) : null}
          {shouldShowThreadPanel &&
            renderedThreadIds.map((threadId) => (
              <SidebarThreadRow
                key={threadId}
                threadId={threadId}
                orderedProjectThreadIds={orderedProjectThreadIds}
                routeThreadId={routeThreadId}
                activeRouteConnectionUrl={activeRouteConnectionUrl}
                connectionUrl={connectionUrl}
                selectedThreadIds={selectedThreadIds}
                showThreadJumpHints={showThreadJumpHints}
                jumpLabel={threadJumpLabelById.get(threadId) ?? null}
                appSettingsConfirmThreadArchive={appSettings.confirmThreadArchive}
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
                openPrLink={openPrLink}
                pr={prByThreadId.get(threadId) ?? null}
              />
            ))}

          {projectExpanded && hasHiddenThreads && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  expandThreadListForProject(project.id);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
                  <span>Show {Math.min(THREAD_REVEAL_STEP, hiddenThreadCount)} more</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {projectExpanded && canCollapseThreadList && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<button type="button" />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  collapseThreadListForProject(project.id);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      </>
    );
  }

  function renderRemoteProjectItem(renderedProject: (typeof renderedRemoteProjects)[number]) {
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

    return (
      <>
        <div className="group/project-header relative">
          <SidebarMenuButton
            size="sm"
            className="cursor-pointer gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent group-hover/project-header:bg-accent"
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
            <span className="flex-1 truncate text-xs font-medium text-foreground">
              {project.name}
            </span>
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
                  className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
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

        <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0.5">
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
              return (
                <SidebarThreadRow
                  key={thread.id}
                  threadId={threadId}
                  orderedProjectThreadIds={sortedThreadIds}
                  routeThreadId={routeThreadId}
                  activeRouteConnectionUrl={activeRouteConnectionUrl}
                  connectionUrl={connectionUrl}
                  selectedThreadIds={selectedThreadIds}
                  showThreadJumpHints={showThreadJumpHints}
                  jumpLabel={null}
                  appSettingsConfirmThreadArchive={appSettings.confirmThreadArchive}
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
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
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
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  collapseThreadListForRemoteProject(projectKey);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      </>
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

  useEffect(() => {
    const headerRow = sidebarHeaderRowRef.current;
    if (!headerRow || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateCompactState = () => {
      setIsSidebarHeaderCompact(headerRow.clientWidth < 168);
    };

    updateCompactState();
    const observer = new ResizeObserver(updateCompactState);
    observer.observe(headerRow);

    return () => {
      observer.disconnect();
    };
  }, []);

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
    startTransition(() => {
      setThreadRevealCountByProject((current) => {
        const nextCount = (current[projectId] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
        return {
          ...current,
          [projectId]: nextCount,
        };
      });
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    startTransition(() => {
      setThreadRevealCountByProject((current) => {
        if (current[projectId] === undefined) return current;
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    });
  }, []);

  const toggleRemoteProject = useCallback((projectKey: string) => {
    startTransition(() => {
      setRemoteProjectExpandedById((current) => ({
        ...current,
        [projectKey]: !(current[projectKey] ?? true),
      }));
    });
  }, []);

  const expandThreadListForRemoteProject = useCallback((projectKey: string) => {
    startTransition(() => {
      setRemoteThreadRevealCountByProject((current) => {
        const nextCount = (current[projectKey] ?? THREAD_REVEAL_STEP) + THREAD_REVEAL_STEP;
        return {
          ...current,
          [projectKey]: nextCount,
        };
      });
    });
  }, []);

  const collapseThreadListForRemoteProject = useCallback((projectKey: string) => {
    startTransition(() => {
      setRemoteThreadRevealCountByProject((current) => {
        if (current[projectKey] === undefined) return current;
        const next = { ...current };
        delete next[projectKey];
        return next;
      });
    });
  }, []);

  const showWordmarkDevBadge = IS_DEV_BUILD && !isSidebarHeaderCompact;
  const wordmark = (
    <div className="flex min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 cursor-pointer items-center gap-1">
              <span className="min-w-0 truncate text-sm font-medium tracking-tight text-foreground">
                {APP_BASE_NAME}
              </span>
              {showWordmarkDevBadge ? (
                <Badge
                  variant="info"
                  size="sm"
                  className="h-5 shrink-0 rounded-full border border-info/20 bg-info/10 px-1.5 text-[9px] font-semibold tracking-[0.16em] uppercase shadow-none"
                >
                  DEV
                </Badge>
              ) : null}
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
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

      <CommandDialog open={searchPaletteOpen} onOpenChange={handleSearchPaletteOpenChange}>
        <CommandDialogPopup className="flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden border border-border/50 bg-popover/98 p-0 shadow-lg rounded-xl">
          <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3 bg-gradient-to-b from-popover/50 to-popover/20">
            {searchPaletteMode === "new-thread-project" ? (
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-accent/80 hover:text-foreground active:scale-95"
                onClick={handleSearchPaletteBack}
                aria-label="Back to search"
              >
                <ChevronLeftIcon className="size-5" strokeWidth={2.5} />
              </button>
            ) : (
              <SearchIcon className="size-5 shrink-0 text-muted-foreground/60" strokeWidth={2} />
            )}
            <input
              ref={searchPaletteInputRef}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border/50 bg-background/60 px-3 text-sm font-medium text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all"
              placeholder={
                searchPaletteMode === "new-thread-project"
                  ? "Select project for a new thread..."
                  : "Search commands, projects, and threads..."
              }
              value={searchPaletteQuery}
              onChange={(event) => handleSearchPaletteQueryChange(event.target.value)}
              onKeyDown={handleSearchPaletteInputKeyDown}
              autoFocus
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" ref={searchPaletteListRef}>
            {searchPaletteItems.length === 0 ? (
              <p className="px-0 py-6 text-center text-sm text-muted-foreground/60">
                No matching results
              </p>
            ) : (
              <div className="py-1">
                {searchPaletteMode === "root" &&
                  normalizedSearchPaletteQuery.length === 0 &&
                  searchPaletteActionItems.length > 0 && (
                    <p className="px-0 pt-0 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                      Actions
                    </p>
                  )}
                {searchPaletteActionItems.map((item) => {
                  const itemIndex = searchPaletteIndexById.get(item.id) ?? -1;
                  const isActive = itemIndex === searchPaletteActiveIndex;
                  const icon =
                    item.type === "action.new-thread" ? (
                      <SquarePenIcon className="size-4 shrink-0" strokeWidth={2} />
                    ) : item.type === "action.new-project" ? (
                      <FolderIcon className="size-4 shrink-0" strokeWidth={2} />
                    ) : (
                      <SettingsIcon className="size-4 shrink-0" strokeWidth={2} />
                    );

                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-search-palette-index={itemIndex}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium transition-all duration-150 rounded-md ${
                        isActive
                          ? "bg-primary/15 text-foreground"
                          : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                      }`}
                      onMouseMove={() => handleSearchPaletteItemHover(item.id)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSearchPaletteSelect(item)}
                    >
                      <span
                        className={`text-muted-foreground ${isActive ? "text-primary/70" : ""}`}
                      >
                        {icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </button>
                  );
                })}

                {searchPaletteProjectItems.length > 0 && (
                  <>
                    <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                      {searchPaletteMode === "new-thread-project"
                        ? "Projects"
                        : normalizedSearchPaletteQuery.length === 0
                          ? "Recent Projects"
                          : "Projects"}
                    </p>
                    {searchPaletteProjectItems.map((item) => {
                      if (item.type !== "project") {
                        return null;
                      }
                      const itemIndex = searchPaletteIndexById.get(item.id) ?? -1;
                      const isActive = itemIndex === searchPaletteActiveIndex;
                      const project =
                        item.connectionUrl === undefined
                          ? projectById.get(item.projectId)
                          : undefined;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-search-palette-index={itemIndex}
                          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-all duration-150 rounded-md ${
                            isActive
                              ? "bg-primary/15 text-foreground"
                              : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onMouseMove={() => handleSearchPaletteItemHover(item.id)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSearchPaletteSelect(item)}
                        >
                          {project ? (
                            <ProjectAvatar project={project} className="size-5" />
                          ) : (
                            <FolderIcon
                              className="size-4 shrink-0 text-muted-foreground/60"
                              strokeWidth={2}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{item.label}</span>
                            <span className="block truncate text-muted-foreground text-xs font-normal">
                              {item.description}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </>
                )}

                {searchPaletteMode === "root" && searchPaletteThreadItems.length > 0 && (
                  <>
                    <p className="px-0 pt-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground/50">
                      {normalizedSearchPaletteQuery.length === 0 ? "Recent Threads" : "Threads"}
                    </p>
                    {searchPaletteThreadItems.map((item) => {
                      const itemIndex = searchPaletteIndexById.get(item.id) ?? -1;
                      const isActive = itemIndex === searchPaletteActiveIndex;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-search-palette-index={itemIndex}
                          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-all duration-150 rounded-md ${
                            isActive
                              ? "bg-primary/15 text-foreground"
                              : "text-foreground/80 hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onMouseMove={() => handleSearchPaletteItemHover(item.id)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSearchPaletteSelect(item)}
                        >
                          <SquarePenIcon
                            className="size-4 shrink-0 text-muted-foreground/60"
                            strokeWidth={2}
                          />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{item.label}</span>
                            <span className="block truncate text-muted-foreground text-xs font-normal">
                              {item.description}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            )}
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
                  Esc
                </span>
                <span className="font-medium">Close</span>
              </span>
            </div>
          </div>
        </CommandDialogPopup>
      </CommandDialog>

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
        <CommandDialogPopup className="flex max-h-[min(31.5rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden border border-border/50 bg-popover/98 p-0 shadow-lg rounded-xl">
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
                ) : isBrowsingProjectPaths ? (
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
                    {projectBrowseResult?.entries.length ? (
                      projectBrowseResult.entries.map((entry, index) => (
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
        <SidebarHeader
          className="drag-region h-[52px] px-4 py-0"
          style={MAC_TITLEBAR_LEFT_INSET_STYLE}
        >
          <div ref={sidebarHeaderRowRef} className="relative flex h-full min-w-0 items-center">
            <div className="flex min-w-0 flex-1 items-center">{wordmark}</div>
          </div>
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3.5 py-3 sm:gap-2.5 sm:px-4 sm:py-3.5">
          <div className="relative flex h-full min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 items-center">{wordmark}</div>
          </div>
        </SidebarHeader>
      )}

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarContent className="gap-0">
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
            <SidebarGroup className="px-2.5 pt-2.5 pb-0">
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-md border border-border/60 bg-secondary/40 px-2.5 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                onClick={openSearchPalette}
                aria-label="Open search"
              >
                <SearchIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Search</span>
                {searchShortcutLabel ? (
                  <span className="rounded border border-border/70 bg-muted/65 px-1.5 py-0.5 text-[10px] text-foreground/82">
                    {searchShortcutLabel}
                  </span>
                ) : null}
              </button>
            </SidebarGroup>
            <SidebarGroup className="px-2.5 py-2.5">
              <div className="mb-1.5 flex items-center justify-between pl-2 pr-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Projects
                </span>
                <div className="flex items-center gap-1">
                  <ProjectSortMenu
                    projectSortOrder={appSettings.sidebarProjectSortOrder}
                    threadSortOrder={appSettings.sidebarThreadSortOrder}
                    onProjectSortOrderChange={(sortOrder) => {
                      updateSettings({ sidebarProjectSortOrder: sortOrder });
                    }}
                    onThreadSortOrderChange={(sortOrder) => {
                      updateSettings({ sidebarThreadSortOrder: sortOrder });
                    }}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={
                            shouldShowProjectPathEntry ? "Cancel add project" : "Add project"
                          }
                          aria-pressed={shouldShowProjectPathEntry}
                          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                          onClick={handleStartAddProject}
                        />
                      }
                    >
                      <PlusIcon
                        className={`size-3.5 transition-transform duration-150 ${
                          shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                        }`}
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="right">
                      {shouldShowProjectPathEntry
                        ? "Cancel add project"
                        : addProjectShortcutLabel
                          ? `Add project (${addProjectShortcutLabel})`
                          : "Add project"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              </div>
              {isManualProjectSorting ? (
                <DndContext
                  sensors={projectDnDSensors}
                  collisionDetection={projectCollisionDetection}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragStart={handleProjectDragStart}
                  onDragEnd={handleProjectDragEnd}
                  onDragCancel={handleProjectDragCancel}
                >
                  <SidebarMenu>
                    <SortableContext
                      items={filteredRenderedProjects.map(
                        (renderedProject) => renderedProject.project.id,
                      )}
                      strategy={verticalListSortingStrategy}
                    >
                      {filteredRenderedProjects.map((renderedProject) => (
                        <SortableProjectItem
                          key={renderedProject.project.id}
                          projectId={renderedProject.project.id}
                        >
                          {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                        </SortableProjectItem>
                      ))}
                    </SortableContext>
                    {renderedRemoteProjects.map((renderedProject) => (
                      <SidebarMenuItem key={renderedProject.projectKey} className="rounded-md">
                        {renderRemoteProjectItem(renderedProject)}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </DndContext>
              ) : (
                <SidebarMenu>
                  {unifiedRenderedProjects.map((renderedProject) => (
                    <SidebarMenuItem key={renderedProject.key} className="rounded-md">
                      {renderedProject.kind === "local"
                        ? renderProjectItem(renderedProject.payload, null)
                        : renderRemoteProjectItem(renderedProject.payload)}
                    </SidebarMenuItem>
                  ))}
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
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="p-2.5">
            <SidebarUpdatePill />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="gap-2.5 px-2.5 py-2 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                  onClick={() => void navigate({ to: "/settings" })}
                >
                  <SettingsIcon className="size-3.5" />
                  <span className="text-xs">Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </>
      )}
    </>
  );
}
