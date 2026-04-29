import {
  IconArchive,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTerminal,
} from "@tabler/icons-react";
import {
  CircleAlertIcon,
  CircleCheckBig,
  GitPullRequestIcon,
  LoaderCircleIcon,
  SparklesIcon,
  TextCursorInput,
  TriangleAlert,
} from "lucide-react";
import { type GitStatusResult, ThreadId } from "@ace/contracts";
import {
  memo,
  type DragEvent,
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { resolveThreadRowClassName, resolveThreadStatusPill } from "../../lib/sidebar";
import { cn } from "../../lib/utils";
import { normalizeWsUrl } from "../../lib/remoteHosts";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

function connectionUrlsEqual(left: string, right: string): boolean {
  return normalizeWsUrl(left) === normalizeWsUrl(right);
}

type ThreadPr = GitStatusResult["pr"];

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: NonNullable<ReturnType<typeof resolveThreadStatusPill>>;
  compact?: boolean;
}) {
  const iconClassName = compact ? "size-3" : "size-3.25";
  const shellClassName = compact ? "size-4" : "size-4.5";

  return (
    <span
      title={status.label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-transparent ${shellClassName} ${status.colorClass}`}
    >
      {status.label === "Error" ? (
        <TriangleAlert className={iconClassName} strokeWidth={2.1} />
      ) : status.label === "Completed" ? (
        <CircleCheckBig className={iconClassName} strokeWidth={2.1} />
      ) : status.label === "Awaiting Input" ? (
        <TextCursorInput
          className={`${iconClassName} sidebar-thread-status-awaiting`}
          strokeWidth={2.05}
        />
      ) : status.label === "Plan Ready" ? (
        <SparklesIcon className={iconClassName} strokeWidth={2.05} />
      ) : status.label === "Pending Approval" ? (
        <CircleAlertIcon className={iconClassName} strokeWidth={2.1} />
      ) : (
        <LoaderCircleIcon
          className={`${iconClassName} ${status.pulse ? "animate-spin" : ""}`}
          strokeWidth={2.05}
        />
      )}
      <span className="sr-only">{status.label}</span>
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

export interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  activeRouteConnectionUrl: string;
  connectionUrl: string;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  isPinned: boolean;
  showPinnedIndicator?: boolean;
  pinEnabled?: boolean;
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
    connectionUrl: string,
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
  attemptArchiveThread: (threadId: ThreadId, connectionUrl: string) => Promise<void>;
  onTogglePinnedThread: (threadId: ThreadId) => void;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
  boardDrag?: {
    isDragging: boolean;
    isDropTarget: boolean;
    onDragEnd: () => void;
    onDragLeave: (event: DragEvent<HTMLLIElement>) => void;
    onDragOver: (event: DragEvent<HTMLLIElement>) => void;
    onDragStart: (event: DragEvent<HTMLAnchorElement>) => void;
    onDrop: (event: DragEvent<HTMLLIElement>) => void;
  } | null;
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );

  if (!thread) {
    return null;
  }

  const isActive =
    props.routeThreadId === thread.id &&
    connectionUrlsEqual(props.activeRouteConnectionUrl, props.connectionUrl);
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
  const canPin = props.pinEnabled ?? true;
  const showPinnedIndicator = props.showPinnedIndicator ?? true;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning || canPin
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const prefetchThreadHistory = () => {
    if (isActive) {
      return;
    }
    props.prefetchThreadHistory(thread.id);
  };
  const pinButtonClassName =
    "pointer-events-none opacity-0 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100";

  return (
    <SidebarMenuSubItem
      className={cn(
        "w-full rounded-md transition-colors",
        props.boardDrag?.isDropTarget ? "bg-primary/[0.08] ring-1 ring-primary/35" : "",
      )}
      data-thread-item
      onDragLeave={props.boardDrag?.onDragLeave}
      onDragOver={props.boardDrag?.onDragOver}
      onDrop={props.boardDrag?.onDrop}
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
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
          }),
          "relative isolate",
          props.boardDrag ? "cursor-grab active:cursor-grabbing" : "",
          props.boardDrag?.isDragging ? "z-20 opacity-80" : "",
        )}
        draggable={Boolean(props.boardDrag) && props.renamingThreadId !== thread.id}
        onDragEnd={props.boardDrag?.onDragEnd}
        onDragStart={props.boardDrag?.onDragStart}
        onMouseEnter={prefetchThreadHistory}
        onFocus={prefetchThreadHistory}
        onClick={(event) => {
          props.handleThreadClick(
            event,
            thread.id,
            props.orderedProjectThreadIds,
            props.connectionUrl,
          );
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
                    className={`inline-flex cursor-pointer items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${prStatus.colorClass}`}
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
          {canPin && props.isPinned && showPinnedIndicator && (
            <IconPinFilled className="size-3 shrink-0 text-sidebar-accent-foreground" />
          )}
          {props.renamingThreadId === thread.id ? (
            <input
              ref={(element) => {
                if (element && props.renamingInputRef.current !== element) {
                  props.renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
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
              <IconTerminal className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
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
                  void props.attemptArchiveThread(thread.id, props.connectionUrl);
                }}
              >
                Confirm
              </button>
            ) : (
              <>
                {canPin && (
                  <div
                    className={`absolute top-1/2 right-6 -translate-y-1/2 transition-opacity duration-150 ${pinButtonClassName}`}
                  >
                    <button
                      type="button"
                      data-thread-selection-safe
                      data-testid={`thread-pin-${thread.id}`}
                      aria-label={`${props.isPinned ? "Unpin" : "Pin"} ${thread.title}`}
                      className={`group/thread-pin inline-flex size-5 cursor-pointer items-center justify-center transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
                        props.isPinned
                          ? "text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
                      }`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onTogglePinnedThread(thread.id);
                      }}
                    >
                      {props.isPinned ? (
                        <span className="relative inline-flex size-4 items-center justify-center">
                          <IconPinFilled className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/thread-pin:opacity-0 group-focus-visible/thread-pin:opacity-0" />
                          <IconPinnedOff className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover/thread-pin:opacity-100 group-focus-visible/thread-pin:opacity-100" />
                        </span>
                      ) : (
                        <IconPin className="size-4" />
                      )}
                    </button>
                  </div>
                )}
                {!isThreadRunning ? (
                  props.appSettingsConfirmThreadArchive ? (
                    <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                      <button
                        type="button"
                        data-thread-selection-safe
                        data-testid={`thread-archive-${thread.id}`}
                        aria-label={`Archive ${thread.title}`}
                        className="inline-flex size-5 cursor-pointer items-center justify-center text-sidebar-foreground/60 transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
                        <IconArchive className="size-3.5" />
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
                              className="inline-flex size-5 cursor-pointer items-center justify-center text-sidebar-foreground/60 transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                              onPointerDown={(event) => {
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void props.attemptArchiveThread(thread.id, props.connectionUrl);
                              }}
                            >
                              <IconArchive className="size-3.5" />
                            </button>
                          </div>
                        }
                      />
                      <TooltipPopup side="top">Archive</TooltipPopup>
                    </Tooltip>
                  )
                ) : null}
              </>
            )}
            <span className={threadMetaClassName}>
              {props.showThreadJumpHints && props.jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-sidebar-border bg-sidebar-accent px-1.5 font-mono text-[10px] font-medium tracking-tight text-sidebar-accent-foreground "
                  title={props.jumpLabel}
                >
                  {props.jumpLabel}
                </span>
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted
                      ? "text-sidebar-accent-foreground/70"
                      : "text-sidebar-foreground/50"
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
