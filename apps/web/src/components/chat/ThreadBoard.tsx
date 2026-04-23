import { type MessageId, type ThreadId, type TurnId } from "@ace/contracts";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Clock3Icon, LoaderCircleIcon, PanelsTopLeftIcon, XIcon } from "lucide-react";

import { type ChatThreadBoardPaneState, useChatThreadBoardStore } from "../../chatThreadBoardStore";
import ChatView from "../ChatView";
import { stripDiffSearchParams } from "../../diffRouteSearch";
import { useSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import { hydrateThreadFromCache, readCachedHydratedThread } from "../../lib/threadHydrationCache";
import { resizePaneRatios, normalizePaneRatios } from "../../lib/paneRatios";
import { isScrollContainerNearBottom, scrollContainerToBottom } from "../../chat-scroll";
import {
  THREAD_ROUTE_CONNECTION_SEARCH_PARAM,
  resolveLocalConnectionUrl,
} from "../../lib/connectionRouting";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  formatElapsed,
  hasLiveTurn,
  isLatestTurnSettled,
} from "../../session-logic";
import { useStore } from "../../store";
import { useProjectById, useSidebarThreadSummaryById, useThreadById } from "../../storeSelectors";
import { projectScriptCwd } from "../../projectScripts";
import type { Thread } from "../../types";
import { cn } from "~/lib/utils";
import {
  deriveThreadActivityRenderState,
  deriveThreadTimelineRenderState,
} from "~/lib/chat/threadRenderState";
import { Button } from "../ui/button";
import { MessagesTimeline } from "./MessagesTimeline";

const BOARD_MIN_COLUMN_WIDTH_PX = 360;
const BOARD_MIN_ROW_HEIGHT_PX = 240;
const EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID = new Map<MessageId, number>();
const EMPTY_THREAD_ACTIVITIES: Thread["activities"] = [];
const EMPTY_THREAD_MESSAGES: Thread["messages"] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];

function buildThreadRouteSearch(connectionUrl: string | null): Record<string, string | undefined> {
  const localConnectionUrl = resolveLocalConnectionUrl();
  if (!connectionUrl || connectionUrl === localConnectionUrl) {
    return {};
  }
  return { [THREAD_ROUTE_CONNECTION_SEARCH_PARAM]: connectionUrl };
}

function isThreadBoardInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      "button, a, input, textarea, select, summary, [role='button'], [data-scroll-anchor-target]",
    ) !== null
  );
}

function ThreadMonitorPane(props: {
  activePaneId: string | null;
  currentRouteConnectionUrl: string;
  isPrimary: boolean;
  pane: ChatThreadBoardPaneState;
  onClose: () => void;
  onPromote: () => void;
  onRequestDiff: (pane: ChatThreadBoardPaneState, turnId: TurnId, filePath?: string) => void;
  setActivePane: (paneId: string) => void;
}) {
  const { pane } = props;
  const settings = useSettings();
  const { resolvedTheme } = useTheme();
  const sidebarThread = useSidebarThreadSummaryById(pane.threadId);
  const thread = useThreadById(pane.threadId);
  const project = useProjectById(thread?.projectId);
  const hydrateThreadFromReadModel = useStore((store) => store.hydrateThreadFromReadModel);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const threadUpdatedAt = thread?.updatedAt ?? null;
  const threadHistoryLoaded = thread?.historyLoaded ?? null;

  useEffect(() => {
    if (!thread || threadHistoryLoaded !== false || !threadUpdatedAt) {
      return;
    }
    const cachedThread = readCachedHydratedThread(pane.threadId, threadUpdatedAt);
    if (cachedThread) {
      startTransition(() => {
        hydrateThreadFromReadModel(cachedThread);
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const readModelThread = await hydrateThreadFromCache(pane.threadId, {
          expectedUpdatedAt: threadUpdatedAt,
        });
        if (cancelled) {
          return;
        }
        startTransition(() => {
          hydrateThreadFromReadModel(readModelThread);
        });
      } catch {
        // Keep the lightweight monitor usable even if hydration is unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hydrateThreadFromReadModel, pane.threadId, thread, threadHistoryLoaded, threadUpdatedAt]);

  const activeLatestTurn = thread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, thread?.session ?? null);
  const liveTurnInProgress = hasLiveTurn(activeLatestTurn, thread?.session ?? null);
  const isWorking = liveTurnInProgress;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    thread?.session ?? null,
    null,
  );
  const activityVisibilitySettings = useMemo(
    () => ({
      enableThinkingStreaming: settings.enableThinkingStreaming,
      enableToolStreaming: settings.enableToolStreaming,
    }),
    [settings.enableThinkingStreaming, settings.enableToolStreaming],
  );
  const threadActivities = thread?.activities ?? EMPTY_THREAD_ACTIVITIES;
  const { workLogEntries } = useMemo(
    () => deriveThreadActivityRenderState(threadActivities, activityVisibilitySettings),
    [activityVisibilitySettings, threadActivities],
  );
  const timelineMessages = thread?.messages ?? EMPTY_THREAD_MESSAGES;
  const proposedPlans = thread?.proposedPlans ?? EMPTY_PROPOSED_PLANS;
  const { turnDiffSummaries } = useTurnDiffSummaries(thread);
  const { timelineEntries, visibleTurnDiffSummaryByAssistantMessageId } = useMemo(
    () =>
      deriveThreadTimelineRenderState({
        messages: timelineMessages,
        proposedPlans,
        workLogEntries,
        turnDiffSummaries,
      }),
    [proposedPlans, timelineMessages, turnDiffSummaries, workLogEntries],
  );
  const completionSummary = useMemo(() => {
    if (!latestTurnSettled || !activeLatestTurn?.startedAt || !activeLatestTurn.completedAt) {
      return null;
    }
    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [activeLatestTurn?.completedAt, activeLatestTurn?.startedAt, latestTurnSettled]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled || !completionSummary) {
      return null;
    }
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const markdownCwd = project
    ? projectScriptCwd({
        project: { cwd: project.cwd },
        worktreePath: thread?.worktreePath ?? null,
      })
    : undefined;
  const monitorTitle = sidebarThread?.title ?? thread?.title ?? "Thread";
  const isRouteConnectionMatch =
    (pane.connectionUrl ?? resolveLocalConnectionUrl()) === props.currentRouteConnectionUrl;
  const lastTimelineEntry = timelineEntries.at(-1);
  const timelineScrollKey = `${pane.threadId}:${String(lastTimelineEntry?.id ?? "")}:${String(
    timelineEntries.length,
  )}:${String(isWorking)}`;

  const scrollMonitorToBottom = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    scrollContainerToBottom(scrollContainer);
  }, []);

  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    scrollMonitorToBottom();
  }, [pane.threadId, scrollMonitorToBottom]);

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) {
      return;
    }
    scrollMonitorToBottom();
    const frame = window.requestAnimationFrame(() => {
      if (shouldAutoScrollRef.current) {
        scrollMonitorToBottom();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrollMonitorToBottom, timelineScrollKey]);

  const handleMonitorScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    shouldAutoScrollRef.current = isScrollContainerNearBottom(scrollContainer);
  }, []);

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        props.isPrimary ? "border-0" : "border-l border-border/80",
      )}
      onPointerDown={() => {
        props.setActivePane(pane.id);
      }}
      onClick={(event) => {
        if (!props.isPrimary && !isThreadBoardInteractiveTarget(event.target)) {
          props.onPromote();
        }
      }}
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3 text-[12px]",
          props.isPrimary ? "bg-background/95" : "bg-muted/20",
        )}
      >
        <span
          className={cn(
            "inline-flex size-2.5 shrink-0 rounded-full",
            isWorking
              ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.14)]"
              : "bg-muted-foreground/35",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{monitorTitle}</div>
        </div>
        {isWorking ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            Running
          </span>
        ) : activeLatestTurn?.completedAt ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock3Icon className="size-3" />
            Idle
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            "h-7 gap-1.5 px-2 text-[11px]",
            props.isPrimary && isRouteConnectionMatch
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={(event) => {
            event.stopPropagation();
            props.setActivePane(pane.id);
            if (!props.isPrimary || !isRouteConnectionMatch) {
              props.onPromote();
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <PanelsTopLeftIcon className="size-3.5" />
          {props.isPrimary && isRouteConnectionMatch ? "Primary" : "Focus"}
        </Button>
        {!props.isPrimary ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            aria-label={`Close ${monitorTitle}`}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={handleMonitorScroll}
      >
        {thread || sidebarThread ? (
          <MessagesTimeline
            hasMessages={timelineEntries.length > 0}
            isWorking={isWorking}
            activeTurnInProgress={isWorking || !latestTurnSettled}
            activeTurnStartedAt={activeWorkStartedAt}
            scrollContainer={scrollContainerRef.current}
            timelineEntries={timelineEntries}
            completionDividerBeforeEntryId={completionDividerBeforeEntryId}
            completionSummary={completionSummary}
            turnDiffSummaryByAssistantMessageId={visibleTurnDiffSummaryByAssistantMessageId}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={(groupId) => {
              setExpandedWorkGroups((existing) => ({
                ...existing,
                [groupId]: !existing[groupId],
              }));
            }}
            onOpenTurnDiff={(turnId, filePath) => {
              props.onRequestDiff(pane, turnId, filePath);
            }}
            revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID}
            onRevertUserMessage={() => undefined}
            isRevertingCheckpoint={false}
            onImageExpand={() => undefined}
            markdownCwd={markdownCwd}
            onOpenBrowserUrl={null}
            resolvedTheme={resolvedTheme}
            timestampFormat={settings.timestampFormat}
            workspaceRoot={project?.cwd}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Open this thread to load its full history into the workspace.
          </div>
        )}
      </div>

      {!props.isPrimary ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 ring-1 ring-inset transition-colors",
            props.activePaneId === pane.id ? "ring-foreground/12" : "ring-border/60",
          )}
        />
      ) : null}
    </div>
  );
}

export function ThreadBoard(props: { connectionUrl?: string | null; threadId: ThreadId }) {
  const navigate = useNavigate();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const rowGroupRefs = useRef(new Map<string, HTMLDivElement>());
  const activePaneId = useChatThreadBoardStore((state) => state.activePaneId);
  const paneRatios = useChatThreadBoardStore((state) => state.paneRatios);
  const panes = useChatThreadBoardStore((state) => state.panes);
  const rows = useChatThreadBoardStore((state) => state.rows);
  const closePane = useChatThreadBoardStore((state) => state.closePane);
  const setActivePane = useChatThreadBoardStore((state) => state.setActivePane);
  const setPaneRatios = useChatThreadBoardStore((state) => state.setPaneRatios);
  const setRowRatios = useChatThreadBoardStore((state) => state.setRowRatios);
  const syncRouteThread = useChatThreadBoardStore((state) => state.syncRouteThread);
  const currentRouteConnectionUrl = props.connectionUrl?.trim() || resolveLocalConnectionUrl();

  useEffect(() => {
    syncRouteThread({
      connectionUrl: props.connectionUrl ?? null,
      threadId: props.threadId,
    });
  }, [props.connectionUrl, props.threadId, syncRouteThread]);

  const primaryPane = useMemo(
    () =>
      panes.find(
        (pane) =>
          pane.threadId === props.threadId &&
          (pane.connectionUrl ?? resolveLocalConnectionUrl()) === currentRouteConnectionUrl,
      ),
    [currentRouteConnectionUrl, panes, props.threadId],
  );
  const normalizedRowRatios = useMemo(
    () => normalizePaneRatios(paneRatios, rows.length),
    [paneRatios, rows.length],
  );
  const paneById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
  const boardVisible = panes.length > 1 && Boolean(primaryPane);

  const promotePane = useCallback(
    (pane: ChatThreadBoardPaneState) => {
      setActivePane(pane.id);
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: pane.threadId },
          search: buildThreadRouteSearch(pane.connectionUrl),
        });
      });
    },
    [navigate, setActivePane],
  );

  const handleOpenTurnDiff = useCallback(
    (pane: ChatThreadBoardPaneState, turnId: TurnId, filePath?: string) => {
      setActivePane(pane.id);
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: pane.threadId },
          search: (previous) => {
            const rest = {
              ...stripDiffSearchParams(previous),
              ...buildThreadRouteSearch(pane.connectionUrl),
            };
            return filePath
              ? { ...rest, diff: "1", diffFilePath: filePath, diffTurnId: turnId }
              : { ...rest, diff: "1", diffTurnId: turnId };
          },
        });
      });
    },
    [navigate, setActivePane],
  );

  const paneResizeStateRef = useRef<{
    dividerIndex: number;
    pointerId: number;
    rowId: string;
    startRatios: number[];
    startX: number;
  } | null>(null);
  const handlePaneResizeStart = useCallback(
    (rowId: string, dividerIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const row = rows.find((candidate) => candidate.id === rowId);
      if (!row) {
        return;
      }
      paneResizeStateRef.current = {
        dividerIndex,
        pointerId: event.pointerId,
        rowId,
        startRatios: [...row.paneRatios],
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [rows],
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
        resizeState.rowId,
        resizePaneRatios({
          containerWidthPx: container.clientWidth,
          deltaPx: event.clientX - resizeState.startX,
          dividerIndex: resizeState.dividerIndex,
          minPaneWidthPx: BOARD_MIN_COLUMN_WIDTH_PX,
          ratios: resizeState.startRatios,
        }),
      );
    },
    [setPaneRatios],
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
      const container = boardRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      setRowRatios(
        resizePaneRatios({
          containerWidthPx: container.clientHeight,
          deltaPx: event.clientY - resizeState.startY,
          dividerIndex: resizeState.dividerIndex,
          minPaneWidthPx: BOARD_MIN_ROW_HEIGHT_PX,
          ratios: resizeState.startRatios,
        }),
      );
    },
    [setRowRatios],
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

  if (!boardVisible || !primaryPane) {
    return <ChatView threadId={props.threadId} />;
  }

  return (
    <div ref={boardRef} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {rows.map((row, rowIndex) => (
        <div
          key={row.id}
          className="flex min-h-0 flex-1 flex-col"
          style={{ flexBasis: 0, flexGrow: normalizedRowRatios[rowIndex] ?? 1 }}
        >
          <div
            ref={(node) => {
              if (node) {
                rowGroupRefs.current.set(row.id, node);
              } else {
                rowGroupRefs.current.delete(row.id);
              }
            }}
            className="flex min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            {row.paneIds.map((paneId, paneIndex) => {
              const pane = paneById.get(paneId);
              if (!pane) {
                return null;
              }
              const isPrimary =
                pane.id === primaryPane.id &&
                (pane.connectionUrl ?? resolveLocalConnectionUrl()) === currentRouteConnectionUrl;
              return (
                <div
                  key={pane.id}
                  className="flex min-h-0 min-w-0"
                  style={{
                    flexBasis: 0,
                    flexGrow: row.paneRatios[paneIndex] ?? 1,
                    minWidth: `${BOARD_MIN_COLUMN_WIDTH_PX}px`,
                  }}
                >
                  {isPrimary ? (
                    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                      <ChatView threadId={props.threadId} />
                    </div>
                  ) : (
                    <ThreadMonitorPane
                      activePaneId={activePaneId}
                      currentRouteConnectionUrl={currentRouteConnectionUrl}
                      isPrimary={false}
                      pane={pane}
                      onClose={() => {
                        closePane(pane.id);
                      }}
                      onPromote={() => {
                        promotePane(pane);
                      }}
                      onRequestDiff={handleOpenTurnDiff}
                      setActivePane={setActivePane}
                    />
                  )}
                  {paneIndex < row.paneIds.length - 1 ? (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize thread panes"
                      className="group relative z-10 -mx-px flex w-2 shrink-0 cursor-col-resize items-center justify-center touch-none select-none"
                      onPointerDown={handlePaneResizeStart(row.id, paneIndex)}
                      onPointerMove={handlePaneResizeMove}
                      onPointerUp={handlePaneResizeEnd}
                      onPointerCancel={handlePaneResizeEnd}
                    >
                      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:bg-foreground/30" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {rowIndex < rows.length - 1 ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize thread rows"
              className="group relative z-10 -my-px flex h-2 shrink-0 cursor-row-resize items-center justify-center touch-none select-none"
              onPointerDown={handleRowResizeStart(rowIndex)}
              onPointerMove={handleRowResizeMove}
              onPointerUp={handleRowResizeEnd}
              onPointerCancel={handleRowResizeEnd}
            >
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/70 transition-colors group-hover:bg-foreground/30" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
