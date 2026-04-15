import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  GitPullRequestIcon,
  LaptopIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
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
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
} from "@ace/contracts";
import { useQueries } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type SidebarProjectSortOrder, type SidebarThreadSortOrder } from "@ace/contracts/settings";
import { isElectron } from "../env";
import { APP_BASE_NAME, APP_VERSION, IS_DEV_BUILD } from "../branding";
import { reportBackgroundError } from "../lib/async";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
import {
  DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME,
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
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";

import { useThreadActions } from "../hooks/useThreadActions";
import {
  ProjectAvatar,
  ProjectGlyphIcon,
  PROJECT_ICON_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
} from "./ProjectAvatar";
import { toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
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
import { Input } from "./ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
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
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadOptions,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "../lib/sidebar";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { prefetchHydratedThread, readCachedHydratedThread } from "../lib/threadHydrationCache";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { useSidebarThreadSummaryById } from "../storeSelectors";
import type { Project, SidebarThreadSummary } from "../types";
import {
  connectToWsHost,
  isHostConnectionActive,
  loadRemoteHostInstances,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  verifyWsHostConnection,
  splitWsUrlAuthToken,
  resolveActiveWsUrl,
  type RemoteHostInstance,
} from "../lib/remoteHosts";
const THREAD_REVEAL_STEP = 5;
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
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

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

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: NonNullable<ReturnType<typeof resolveThreadStatusPill>>;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "animate-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  prefetchThreadHistory: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );

  if (!thread) {
    return null;
  }

  const isActive = props.routeThreadId === thread.id;
  const isSelected = props.selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = props.confirmingArchiveThreadId === thread.id && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const prefetchThreadHistory = () => {
    if (thread.id === props.routeThreadId) {
      return;
    }
    props.prefetchThreadHistory(thread.id);
  };

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={() => {
        props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
        });
      }}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onMouseEnter={prefetchThreadHistory}
        onFocus={prefetchThreadHistory}
        onClick={(event) => {
          props.handleThreadClick(event, thread.id, props.orderedProjectThreadIds);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.navigateToThread(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (props.selectedThreadIds.size > 0 && props.selectedThreadIds.has(thread.id)) {
            void props.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (props.selectedThreadIds.size > 0) {
              props.clearSelection();
            }
            void props.handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={(event) => {
                      props.openPrLink(event, prStatus.url);
                    }}
                  >
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {threadStatus && <ThreadStatusLabel status={threadStatus} />}
          {props.renamingThreadId === thread.id ? (
            <input
              ref={(element) => {
                if (element && props.renamingInputRef.current !== element) {
                  props.renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={props.renamingTitle}
              onChange={(event) => props.setRenamingTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  void props.commitRename(thread.id, props.renamingTitle, thread.title);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  props.cancelRename();
                }
              }}
              onBlur={() => {
                if (!props.renamingCommittedRef.current) {
                  void props.commitRename(thread.id, props.renamingTitle, thread.title);
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus && (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          )}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={(element) => {
                  if (element) {
                    props.confirmArchiveButtonRefs.current.set(thread.id, element);
                  } else {
                    props.confirmArchiveButtonRefs.current.delete(thread.id);
                  }
                }}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.setConfirmingArchiveThreadId((current) =>
                    current === thread.id ? null : current,
                  );
                  void props.attemptArchiveThread(thread.id);
                }}
              >
                Confirm
              </button>
            ) : !isThreadRunning ? (
              props.appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.setConfirmingArchiveThreadId(thread.id);
                      requestAnimationFrame(() => {
                        props.confirmArchiveButtonRefs.current.get(thread.id)?.focus();
                      });
                    }}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void props.attemptArchiveThread(thread.id);
                          }}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span className={threadMetaClassName}>
              {props.showThreadJumpHints && props.jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-border/50 bg-background/80 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                  title={props.jumpLabel}
                >
                  {props.jumpLabel}
                </span>
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted ? "text-foreground/60" : "text-muted-foreground/50"
                  }`}
                >
                  {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
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

export default function Sidebar() {
  const { isMobile, state } = useSidebar();
  const projects = useStore((store) => store.projects);
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
  const sidebarToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "sidebar.toggle"),
    [keybindings],
  );
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<ThreadId | null>(null);
  const [threadRevealCountByProject, setThreadRevealCountByProject] = useState<
    Partial<Record<ProjectId, number>>
  >({});
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<ProjectId | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [editingProjectIcon, setEditingProjectIcon] = useState<Project["icon"]>(null);
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
  const [savedRemoteHosts, setSavedRemoteHosts] = useState<RemoteHostInstance[]>(() =>
    loadRemoteHostInstances(),
  );
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shouldShowProjectPathEntry = addingProject;
  const activeHostWsUrl = useMemo(() => resolveActiveWsUrl(), []);
  const localHostIdentity = useMemo(() => splitWsUrlAuthToken(resolveLocalDeviceWsUrl()), []);
  const localHostConnectionUrl = useMemo(() => {
    return resolveHostConnectionWsUrl(localHostIdentity);
  }, [localHostIdentity]);
  const localHostIsActive = useMemo(
    () => isHostConnectionActive(localHostIdentity, activeHostWsUrl),
    [activeHostWsUrl, localHostIdentity],
  );
  const activeRemoteHost = useMemo(
    () => savedRemoteHosts.find((host) => isHostConnectionActive(host, activeHostWsUrl)) ?? null,
    [activeHostWsUrl, savedRemoteHosts],
  );
  const hostSwitcherLabel = activeRemoteHost?.name ?? "Current device";
  const activeProjects = useMemo(
    () => projects.filter((project) => project.archivedAt === null),
    [projects],
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
  const editingProject = useMemo(
    () =>
      editingProjectId
        ? (projects.find((project) => project.id === editingProjectId) ?? null)
        : null,
    [editingProjectId, projects],
  );
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

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
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

  const addProjectFromPath = useCallback(
    async (rawCwd: string, options?: { revealOnError?: boolean }) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        try {
          if (existing.archivedAt !== null) {
            await api.orchestration.dispatchCommand({
              type: "project.meta.update",
              commandId: newCommandId(),
              projectId: existing.id,
              archivedAt: null,
            });
          }
          focusMostRecentThreadForProject(existing.id);
          finishAddingProject();
        } catch (error) {
          setIsAddingProject(false);
          toastManager.add({
            type: "error",
            title: `Failed to restore "${existing.name}"`,
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch((error) => {
          reportBackgroundError("Failed to create the initial thread for the new project.", error);
        });
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
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async (options?: { revealOnCancel?: boolean }) => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setAddProjectError(null);
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (pickedPath) {
        setNewCwd(pickedPath);
        await addProjectFromPath(pickedPath, { revealOnError: true });
        return;
      }
      if (options?.revealOnCancel) {
        setAddingProject(true);
      }
      addProjectInputRef.current?.focus();
    } catch (error) {
      setAddingProject(true);
      setAddProjectError(
        error instanceof Error ? error.message : "Unable to open the folder picker.",
      );
      addProjectInputRef.current?.focus();
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldShowProjectPathEntry) {
      setAddingProject(false);
      return;
    }
    void handlePickFolder({ revealOnCancel: true });
  };

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
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
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
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
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

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
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
        void navigate({
          to: "/$threadId",
          params: { threadId },
        });
      });
    },
    [
      clearSelection,
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
        });
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor, sidebarThreadsById],
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
          await api.orchestration.dispatchCommand({
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
        await api.orchestration.dispatchCommand({
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
      projects,
      setEditingProjectIcon,
      setEditingProjectId,
      setEditingProjectName,
      setProjectEditorOpen,
      threadIdsByProjectId,
    ],
  );

  const closeProjectEditor = useCallback(() => {
    setProjectEditorOpen(false);
    setEditingProjectId(null);
    setEditingProjectName("");
    setEditingProjectIcon(null);
  }, []);

  const saveProjectEdits = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      if (!editingProject) {
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
        trimmedName === editingProject.name &&
        projectIconsEqual(editingProject.icon, editingProjectIcon)
      ) {
        closeProjectEditor();
        return;
      }

      const api = readNativeApi();
      if (!api) {
        closeProjectEditor();
        return;
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: editingProject.id,
          title: trimmedName,
          icon: editingProjectIcon,
        });
        closeProjectEditor();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to update "${editingProject.name}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [closeProjectEditor, editingProject, editingProjectIcon, editingProjectName],
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
      next.set(project.id, []);
    }
    for (const [projectId, threadIds] of Object.entries(threadIdsByProjectId)) {
      const projectThreads: SidebarThreadSummary[] = [];
      for (const threadId of threadIds) {
        const thread = sidebarThreadsById[threadId];
        if (!thread || thread.archivedAt !== null) {
          continue;
        }
        projectThreads.push(thread);
      }
      next.set(ProjectId.makeUnsafe(projectId), projectThreads);
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
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
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
        };
      }),
    [
      appSettings.sidebarThreadSortOrder,
      threadRevealCountByProject,
      projectExpandedById,
      sortedProjects,
      activeThreadId,
      threadLastVisitedAtById,
      visibleProjectThreadsByProjectId,
    ],
  );
  const visibleSidebarThreadIds = useMemo(
    () => getVisibleSidebarThreadIds(renderedProjects),
    [renderedProjects],
  );
  const visibleSidebarThreads = useMemo(
    () =>
      visibleSidebarThreadIds.flatMap((threadId) => {
        const thread = sidebarThreadsById[threadId];
        return thread ? [thread] : [];
      }),
    [sidebarThreadsById, visibleSidebarThreadIds],
  );
  const threadGitTargets = useMemo(
    () =>
      visibleSidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, visibleSidebarThreads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
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
    navigateToThread,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
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
                    void handleNewThread(
                      project.id,
                      resolveSidebarNewThreadOptions({
                        projectId: project.id,
                        defaultEnvMode: resolveSidebarNewThreadEnvMode({
                          defaultEnvMode: appSettings.defaultThreadEnvMode,
                        }),
                        activeThread:
                          activeThread && activeThread.projectId === project.id
                            ? {
                                projectId: activeThread.projectId,
                                branch: activeThread.branch,
                                worktreePath: activeThread.worktreePath,
                              }
                            : null,
                        activeDraftThread:
                          activeDraftThread && activeDraftThread.projectId === project.id
                            ? {
                                projectId: activeDraftThread.projectId,
                                branch: activeDraftThread.branch,
                                worktreePath: activeDraftThread.worktreePath,
                                envMode: activeDraftThread.envMode,
                              }
                            : null,
                      }),
                    );
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
  const [switchingHostTarget, setSwitchingHostTarget] = useState<string | null>(null);
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

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

  useEffect(() => {
    const syncHosts = () => {
      setSavedRemoteHosts(loadRemoteHostInstances());
    };
    syncHosts();
    window.addEventListener("storage", syncHosts);
    const handle = window.setInterval(syncHosts, 10_000);
    return () => {
      window.removeEventListener("storage", syncHosts);
      window.clearInterval(handle);
    };
  }, []);

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
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const switchToHostConnection = useCallback(
    async (targetWsUrl: string) => {
      if (switchingHostTarget !== null) {
        return;
      }
      setSwitchingHostTarget(targetWsUrl);
      try {
        await verifyWsHostConnection(targetWsUrl);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not switch host.",
          description:
            error instanceof Error ? error.message : "Host connection check did not complete.",
        });
        setSwitchingHostTarget(null);
        return;
      }
      connectToWsHost(targetWsUrl);
    },
    [switchingHostTarget],
  );

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
        open={projectEditorOpen && editingProject !== null}
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
            {editingProject ? (
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
                          cwd: editingProject.cwd,
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

      {isElectron ? (
        <SidebarHeader
          className="drag-region h-[52px] px-4 py-0"
          style={MAC_TITLEBAR_LEFT_INSET_STYLE}
        >
          <div ref={sidebarHeaderRowRef} className="relative flex h-full min-w-0 items-center">
            <div
              className={`flex min-w-0 flex-1 items-center justify-center ${
                !isMobile && state === "expanded" ? "pr-10" : ""
              }`}
            >
              {wordmark}
            </div>
            {!isMobile && state === "expanded" ? (
              <div className="absolute inset-y-0 right-0 flex items-center">
                <Tooltip>
                  <TooltipTrigger
                    render={<SidebarTrigger className={DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME} />}
                  />
                  <TooltipPopup side="bottom">
                    {sidebarToggleShortcutLabel
                      ? `Toggle sidebar (${sidebarToggleShortcutLabel})`
                      : "Toggle sidebar"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            ) : null}
          </div>
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3.5 py-3 sm:gap-2.5 sm:px-4 sm:py-3.5">
          {wordmark}
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
            <SidebarGroup className="px-2.5 py-2.5">
              <div className="mb-1.5 flex items-center justify-between pl-2 pr-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Projects
                </span>
                <div className="flex items-center gap-1">
                  <Menu>
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex h-5 items-center gap-1 rounded-md border border-border/60 px-1.5 text-[10px] text-muted-foreground/80 hover:bg-accent hover:text-foreground"
                          aria-label="Switch thread source device"
                        />
                      }
                    >
                      <span className="max-w-24 truncate">{hostSwitcherLabel}</span>
                      <ChevronsUpDownIcon className="size-3" />
                    </MenuTrigger>
                    <MenuPopup align="end" side="bottom" className="min-w-52">
                      <MenuGroup>
                        <button
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                            localHostIsActive
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                          onClick={() => void switchToHostConnection(localHostConnectionUrl)}
                          disabled={switchingHostTarget !== null}
                        >
                          <LaptopIcon className="size-3.5" />
                          <span className="truncate">Current device</span>
                        </button>
                        {savedRemoteHosts.map((host) => {
                          const active = isHostConnectionActive(host, activeHostWsUrl);
                          return (
                            <button
                              key={host.id}
                              type="button"
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                                active
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
                              }`}
                              onClick={() =>
                                void switchToHostConnection(resolveHostConnectionWsUrl(host))
                              }
                              disabled={switchingHostTarget !== null}
                            >
                              <ProjectGlyphIcon
                                icon={{
                                  glyph: host.iconGlyph ?? "folder",
                                  color: host.iconColor ?? "slate",
                                }}
                                className="size-3.5"
                              />
                              <span className="truncate">{host.name}</span>
                            </button>
                          );
                        })}
                      </MenuGroup>
                    </MenuPopup>
                  </Menu>
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
                      {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              </div>
              {shouldShowProjectPathEntry && (
                <div className="mb-2 px-1">
                  <button
                    type="button"
                    className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border/50 bg-secondary/70 py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void handlePickFolder()}
                    disabled={isPickingFolder || isAddingProject}
                  >
                    <FolderIcon className="size-3.5" />
                    {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                  </button>
                  <div className="flex gap-1.5">
                    <input
                      ref={addProjectInputRef}
                      className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                        addProjectError
                          ? "border-red-500/70 focus:border-red-500"
                          : "border-border focus:border-ring"
                      }`}
                      placeholder="/path/to/project"
                      value={newCwd}
                      onChange={(event) => {
                        setNewCwd(event.target.value);
                        setAddProjectError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleAddProject();
                        if (event.key === "Escape") {
                          setAddingProject(false);
                          setAddProjectError(null);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                      onClick={handleAddProject}
                      disabled={!canAddProject}
                    >
                      {isAddingProject ? "Adding..." : "Add"}
                    </button>
                  </div>
                  {addProjectError && (
                    <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                      {addProjectError}
                    </p>
                  )}
                </div>
              )}

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
                      items={renderedProjects.map((renderedProject) => renderedProject.project.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {renderedProjects.map((renderedProject) => (
                        <SortableProjectItem
                          key={renderedProject.project.id}
                          projectId={renderedProject.project.id}
                        >
                          {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                        </SortableProjectItem>
                      ))}
                    </SortableContext>
                  </SidebarMenu>
                </DndContext>
              ) : (
                <SidebarMenu>
                  {renderedProjects.map((renderedProject) => (
                    <SidebarMenuItem key={renderedProject.project.id} className="rounded-md">
                      {renderProjectItem(renderedProject, null)}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}

              {projects.length === 0 && !shouldShowProjectPathEntry && (
                <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
                  No projects yet
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
