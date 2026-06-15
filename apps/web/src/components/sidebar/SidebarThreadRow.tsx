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
  GitBranchPlusIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  SparklesIcon,
  SplitIcon,
  TextCursorInput,
  TriangleAlert,
} from "lucide-react";
import { type GitStatusResult, ThreadId } from "@ace/contracts";
import {
  type DragEvent,
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { resolveThreadRowClassName, resolveThreadStatusPill } from "../../lib/sidebar";
import { cn } from "../../lib/utils";
import { normalizeWsUrl } from "../../lib/remoteHosts";
import { hasLiveTurn } from "../../session-logic";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  Icon: typeof GitPullRequestIcon;
  tooltip: string;
  url: string;
}

interface WorktreeStatusIndicator {
  label: string;
}

function connectionUrlsEqual(left: string, right: string): boolean {
  return normalizeWsUrl(left) === normalizeWsUrl(right);
}

type ThreadPr = GitStatusResult["pr"];

function ThreadStatusLabel({
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
      aria-label={status.label}
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
      Icon: GitPullRequestIcon,
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      Icon: GitPullRequestClosedIcon,
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      Icon: GitMergeIcon,
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function worktreeStatusIndicator(thread: { branch: string | null; worktreePath: string | null }) {
  if (!thread.worktreePath) {
    return null;
  }
  return {
    label: thread.branch ? `Worktree: ${thread.branch}` : "Worktree",
  } satisfies WorktreeStatusIndicator;
}

function ForkedThreadIndicator() {
  return (
    <span
      aria-label="Forked chat"
      title="Forked chat"
      className="inline-flex shrink-0 items-center justify-center text-sidebar-foreground/45"
    >
      <SplitIcon className="size-3 rotate-90" strokeWidth={2.15} />
    </span>
  );
}

interface ThreadRowTitleProps {
  readonly canPin: boolean;
  readonly cancelRename: () => void;
  readonly commitRename: SidebarThreadRowProps["commitRename"];
  readonly isPinned: boolean;
  readonly renamingCommittedRef: MutableRefObject<boolean>;
  readonly renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  readonly renamingThreadId: ThreadId | null;
  readonly renamingTitle: string;
  readonly setRenamingTitle: (title: string) => void;
  readonly showPinnedIndicator: boolean;
  readonly thread: NonNullable<ReturnType<typeof useSidebarThreadSummaryById>>;
  readonly threadStatus: ReturnType<typeof resolveThreadStatusPill>;
}

function ThreadRowTitle({
  canPin,
  cancelRename,
  commitRename,
  isPinned,
  renamingCommittedRef,
  renamingInputRef,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  showPinnedIndicator,
  thread,
  threadStatus,
}: ThreadRowTitleProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
      {threadStatus && <ThreadStatusLabel status={threadStatus} />}
      {canPin && isPinned && showPinnedIndicator && (
        <IconPinFilled className="size-3 shrink-0 text-sidebar-accent-foreground" />
      )}
      {thread.fork && <ForkedThreadIndicator />}
      {renamingThreadId === thread.id ? (
        <input
          aria-label="Thread title"
          ref={(element) => {
            if (element && renamingInputRef.current !== element) {
              renamingInputRef.current = element;
              element.focus();
              element.select();
            }
          }}
          className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-xs outline-none"
          value={renamingTitle}
          onChange={(event) => setRenamingTitle(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              renamingCommittedRef.current = true;
              void commitRename(thread.id, renamingTitle, thread.title);
            } else if (event.key === "Escape") {
              event.preventDefault();
              renamingCommittedRef.current = true;
              cancelRename();
            }
          }}
          onBlur={() => {
            if (!renamingCommittedRef.current) {
              void commitRename(thread.id, renamingTitle, thread.title);
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
      )}
    </div>
  );
}

interface ThreadRowTrailingProps {
  readonly metaLabel: string;
  readonly metaLabelActive: boolean;
  readonly metaTone: "active" | "muted";
  readonly prStatus: PrStatusIndicator | null;
  readonly terminalStatus: TerminalStatusIndicator | null;
  readonly threadGitMetaClassName: string;
  readonly threadMetaClassName: string;
  readonly worktreeStatus: WorktreeStatusIndicator | null;
}

function ThreadRowTrailing({
  metaLabel,
  metaLabelActive,
  metaTone,
  prStatus,
  terminalStatus,
  threadGitMetaClassName,
  threadMetaClassName,
  worktreeStatus,
}: ThreadRowTrailingProps) {
  const PrStatusIcon = prStatus?.Icon ?? GitPullRequestIcon;

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {terminalStatus && (
        <span
          aria-label={terminalStatus.label}
          title={terminalStatus.label}
          className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
        >
          <IconTerminal
            className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
            aria-hidden="true"
          />
        </span>
      )}
      <div className="flex min-w-12 justify-end">
        {(worktreeStatus || prStatus) && (
          <span className={cn(threadGitMetaClassName, "mr-2 inline-flex items-center gap-1")}>
            {worktreeStatus && (
              <span
                aria-label={worktreeStatus.label}
                title={worktreeStatus.label}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-sidebar-foreground/45"
              >
                <GitBranchPlusIcon className="size-3" />
              </span>
            )}
            {prStatus && (
              <span
                aria-label={prStatus.tooltip}
                title={prStatus.tooltip}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-sidebar-foreground/45"
              >
                <PrStatusIcon className="size-3" />
              </span>
            )}
          </span>
        )}
        <span className={cn(threadMetaClassName, "inline-flex items-center")}>
          {metaLabelActive ? (
            <span className="inline-flex h-5 items-center rounded-full border border-sidebar-border bg-sidebar-accent px-1.5 font-mono text-[10px] font-medium tracking-tight text-sidebar-accent-foreground ">
              {metaLabel}
            </span>
          ) : (
            <span
              className={`text-[10px] ${
                metaTone === "active"
                  ? "text-sidebar-accent-foreground/70"
                  : "text-sidebar-foreground/50"
              }`}
            >
              {metaLabel}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

interface ThreadRowActionsProps {
  readonly archiveMode: "archive-now" | "confirm-before-archive" | "confirming" | "disabled";
  readonly attemptArchiveThread: SidebarThreadRowProps["attemptArchiveThread"];
  readonly confirmArchiveButtonRefs: SidebarThreadRowProps["confirmArchiveButtonRefs"];
  readonly connectionUrl: string;
  readonly pinState: "pinned" | "unpinned" | null;
  readonly onTogglePinnedThread: (threadId: ThreadId) => void;
  readonly openPrLink: SidebarThreadRowProps["openPrLink"];
  readonly prStatus: PrStatusIndicator | null;
  readonly setConfirmingArchiveThreadId: SidebarThreadRowProps["setConfirmingArchiveThreadId"];
  readonly thread: NonNullable<ReturnType<typeof useSidebarThreadSummaryById>>;
}

function ThreadRowActions({
  archiveMode,
  attemptArchiveThread,
  confirmArchiveButtonRefs,
  connectionUrl,
  pinState,
  onTogglePinnedThread,
  openPrLink,
  prStatus,
  setConfirmingArchiveThreadId,
  thread,
}: ThreadRowActionsProps) {
  const PrStatusIcon = prStatus?.Icon ?? GitPullRequestIcon;

  return (
    <>
      {archiveMode === "confirming" ? (
        <div className="absolute top-1/2 right-1 z-10 -translate-y-1/2">
          <button
            ref={(element) => {
              if (element) {
                confirmArchiveButtonRefs.current.set(thread.id, element);
              } else {
                confirmArchiveButtonRefs.current.delete(thread.id);
              }
            }}
            type="button"
            data-thread-selection-safe
            data-testid={`thread-archive-confirm-${thread.id}`}
            aria-label={`Confirm archive ${thread.title}`}
            className="inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
              void attemptArchiveThread(thread.id, connectionUrl);
            }}
          >
            Confirm
          </button>
        </div>
      ) : (
        <div className="pointer-events-none absolute top-1/2 right-1 z-10 inline-flex -translate-y-1/2 flex-row-reverse items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
          {archiveMode !== "disabled" ? (
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-archive-${thread.id}`}
              aria-label={`Archive ${thread.title}`}
              title="Archive"
              className="inline-flex size-5 cursor-pointer items-center justify-center text-sidebar-foreground/60 transition-colors hover:text-sidebar-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (archiveMode === "confirm-before-archive") {
                  setConfirmingArchiveThreadId(thread.id);
                  requestAnimationFrame(() => {
                    confirmArchiveButtonRefs.current.get(thread.id)?.focus();
                  });
                  return;
                }
                void attemptArchiveThread(thread.id, connectionUrl);
              }}
            >
              <IconArchive className="size-3.5" />
            </button>
          ) : null}
          {pinState && (
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-pin-${thread.id}`}
              aria-label={`${pinState === "pinned" ? "Unpin" : "Pin"} ${thread.title}`}
              title={pinState === "pinned" ? "Unpin" : "Pin"}
              className={`group/thread-pin inline-flex size-5 cursor-pointer items-center justify-center transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${
                pinState === "pinned"
                  ? "text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
              }`}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePinnedThread(thread.id);
              }}
            >
              {pinState === "pinned" ? (
                <span className="relative inline-flex size-4 items-center justify-center">
                  <IconPinFilled className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover/thread-pin:opacity-0 group-focus-visible/thread-pin:opacity-0" />
                  <IconPinnedOff className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover/thread-pin:opacity-100 group-focus-visible/thread-pin:opacity-100" />
                </span>
              ) : (
                <IconPin className="size-4" />
              )}
            </button>
          )}
          {prStatus ? (
            <button
              type="button"
              data-thread-selection-safe
              aria-label={prStatus.tooltip}
              title={prStatus.tooltip}
              className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-sidebar-foreground/45 outline-hidden transition-colors hover:text-sidebar-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                openPrLink(event, prStatus.url);
              }}
            >
              <PrStatusIcon className="size-3" />
            </button>
          ) : null}
        </div>
      )}
    </>
  );
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
  prefetchThreadHistory: (
    threadId: ThreadId,
    options?: {
      readonly hydrateStore?: boolean;
      readonly prewarmRows?: boolean;
      readonly priority?: "background" | "immediate";
    },
  ) => void;
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

export function SidebarThreadRow({
  renamingCommittedRef,
  renamingInputRef,
  ...props
}: SidebarThreadRowProps) {
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
  const isThreadRunning = hasLiveTurn(thread.latestTurn, thread.session);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const prStatus = prStatusIndicator(props.pr);
  const worktreeStatus = worktreeStatusIndicator(thread);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = props.confirmingArchiveThreadId === thread.id && !isThreadRunning;
  const canPin = props.pinEnabled ?? true;
  const showPinnedIndicator = props.showPinnedIndicator ?? true;
  const archiveMode = isConfirmingArchive
    ? "confirming"
    : isThreadRunning
      ? "disabled"
      : props.appSettingsConfirmThreadArchive
        ? "confirm-before-archive"
        : "archive-now";
  const pinState = canPin ? (props.isPinned ? "pinned" : "unpinned") : null;
  const metaLabel =
    props.showThreadJumpHints && props.jumpLabel
      ? props.jumpLabel
      : formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt);
  const metaLabelActive = props.showThreadJumpHints && props.jumpLabel !== null;
  const metaTone = isHighlighted ? "active" : "muted";
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning || canPin
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:invisible group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:invisible group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const threadGitMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : archiveMode !== "disabled" || pinState
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:invisible group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:invisible group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  const prefetchThreadHistory = () => {
    if (isActive) {
      return;
    }
    props.prefetchThreadHistory(thread.id);
  };

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
        render={<button type="button" aria-label={`Open thread ${thread.title}`} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={cn(
          resolveThreadRowClassName({
            isActive,
            isSelected,
          }),
          "relative isolate",
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
        <ThreadRowTitle
          canPin={canPin}
          cancelRename={props.cancelRename}
          commitRename={props.commitRename}
          isPinned={props.isPinned}
          renamingCommittedRef={renamingCommittedRef}
          renamingInputRef={renamingInputRef}
          renamingThreadId={props.renamingThreadId}
          renamingTitle={props.renamingTitle}
          setRenamingTitle={props.setRenamingTitle}
          showPinnedIndicator={showPinnedIndicator}
          thread={thread}
          threadStatus={threadStatus}
        />
        <ThreadRowTrailing
          metaLabel={metaLabel}
          metaLabelActive={metaLabelActive}
          metaTone={metaTone}
          prStatus={prStatus}
          terminalStatus={terminalStatus}
          threadGitMetaClassName={threadGitMetaClassName}
          threadMetaClassName={threadMetaClassName}
          worktreeStatus={worktreeStatus}
        />
      </SidebarMenuSubButton>
      <ThreadRowActions
        archiveMode={archiveMode}
        attemptArchiveThread={props.attemptArchiveThread}
        confirmArchiveButtonRefs={props.confirmArchiveButtonRefs}
        connectionUrl={props.connectionUrl}
        pinState={pinState}
        onTogglePinnedThread={props.onTogglePinnedThread}
        openPrLink={props.openPrLink}
        prStatus={prStatus}
        setConfirmingArchiveThreadId={props.setConfirmingArchiveThreadId}
        thread={thread}
      />
    </SidebarMenuSubItem>
  );
}
