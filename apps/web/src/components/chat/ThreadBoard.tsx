import { type ThreadId } from "@ace/contracts";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon, XIcon } from "lucide-react";

import { type ChatThreadBoardPaneState, useChatThreadBoardStore } from "../../chatThreadBoardStore";
import ChatView from "../ChatView";
import { resizePaneRatios, normalizePaneRatios } from "../../lib/paneRatios";
import {
  THREAD_ROUTE_CONNECTION_SEARCH_PARAM,
  resolveLocalConnectionUrl,
} from "../../lib/connectionRouting";
import {
  THREAD_BOARD_ACTIVE_SEARCH_PARAM,
  THREAD_BOARD_SPLIT_SEARCH_PARAM,
  THREAD_BOARD_THREADS_SEARCH_PARAM,
  buildThreadBoardRouteSearch,
  type ChatThreadBoardRoutePane,
} from "../../lib/chatThreadBoardRouteSearch";
import {
  buildThreadBoardLayoutOptions,
  getCurrentLayoutColumns,
} from "../../lib/threadBoardLayout";
import {
  getThreadBoardDragThreadKey,
  readThreadBoardDragThread,
  type ThreadBoardDragThread,
} from "../../lib/threadBoardDrag";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

const BOARD_MIN_COLUMN_WIDTH_PX = 360;
const BOARD_MIN_ROW_HEIGHT_PX = 240;
const EMPTY_ROUTE_THREADS: readonly ChatThreadBoardRoutePane[] = [];
type ThreadBoardDropDirection = "down" | "left" | "right" | "up";

interface ThreadBoardDropTargetState {
  direction: ThreadBoardDropDirection;
  paneId: string;
  thread: ThreadBoardDragThread;
}

function isSameRoutePane(left: ChatThreadBoardRoutePane, right: ChatThreadBoardRoutePane): boolean {
  return left.threadId === right.threadId && left.connectionUrl === right.connectionUrl;
}

function resolveThreadBoardDropDirection(
  event: Pick<ReactDragEvent<HTMLElement>, "clientX" | "clientY">,
  rect: DOMRect,
): ThreadBoardDropDirection {
  const xRatio = rect.width <= 0 ? 0.5 : (event.clientX - rect.left) / rect.width;
  const yRatio = rect.height <= 0 ? 0.5 : (event.clientY - rect.top) / rect.height;

  if (xRatio <= 0.28) {
    return "left";
  }
  if (xRatio >= 0.72) {
    return "right";
  }
  if (yRatio <= 0.28) {
    return "up";
  }
  if (yRatio >= 0.72) {
    return "down";
  }

  const distances = [
    { direction: "left" as const, value: xRatio },
    { direction: "right" as const, value: 1 - xRatio },
    { direction: "up" as const, value: yRatio },
    { direction: "down" as const, value: 1 - yRatio },
  ];
  return distances.reduce((closest, candidate) =>
    candidate.value < closest.value ? candidate : closest,
  ).direction;
}

function ThreadBoardDropPreview(props: {
  direction: ThreadBoardDropDirection;
  isSinglePane: boolean;
}) {
  const frameClassName =
    props.direction === "left"
      ? "right-1/2 w-1/2"
      : props.direction === "right"
        ? "left-1/2 w-1/2"
        : props.direction === "up"
          ? "bottom-1/2 h-1/2"
          : "top-1/2 h-1/2";

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-30 rounded-[inherit] border border-primary/35 bg-primary/[0.05]" />
      <div
        className={cn(
          "pointer-events-none absolute z-[31] rounded-[inherit] border border-primary/45 bg-primary/[0.14] ",
          props.direction === "left" || props.direction === "right"
            ? "top-0 bottom-0"
            : "left-0 right-0",
          frameClassName,
        )}
      />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-[32] flex justify-center">
        <div className="rounded-full border border-primary/30 bg-background/92 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-primary/85 uppercase  backdrop-blur">
          {props.isSinglePane ? "Create split" : "Insert pane"} {props.direction}
        </div>
      </div>
    </>
  );
}

function isThreadBoardInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      "button, a, input, textarea, select, summary, [contenteditable='true'], [role='button'], [role='textbox'], [data-chat-composer-form], [data-scroll-anchor-target]",
    ) !== null
  );
}

function ThreadBoardPane(props: {
  activePaneId: string | null;
  dropPreviewDirection?: ThreadBoardDropDirection | null;
  isSinglePane: boolean;
  splitPane?: boolean;
  shortcutsEnabled: boolean;
  isPrimary: boolean;
  pane: ChatThreadBoardPaneState;
  showSidebarTrigger: boolean;
  onDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onPromote: () => void;
  setActivePane: (paneId: string) => void;
}) {
  const { pane } = props;
  const sidebarThread = useSidebarThreadSummaryById(pane.threadId);
  const paneTitle = sidebarThread?.title ?? "thread";

  return (
    <div
      className={cn(
        "group/thread-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        props.isPrimary ? "border-0" : "border-l border-border/80",
      )}
      onDragLeave={props.onDragLeave}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onPointerDown={() => {
        props.setActivePane(pane.id);
      }}
      onClick={(event) => {
        if (!props.isPrimary && !isThreadBoardInteractiveTarget(event.target)) {
          props.onPromote();
        }
      }}
    >
      <ChatView
        connectionUrl={pane.connectionUrl}
        threadId={pane.threadId}
        shortcutsEnabled={props.shortcutsEnabled}
        showSidebarTrigger={props.showSidebarTrigger}
        splitPane={props.splitPane ?? true}
      />

      {props.dropPreviewDirection ? (
        <ThreadBoardDropPreview
          direction={props.dropPreviewDirection}
          isSinglePane={props.isSinglePane}
        />
      ) : null}

      {!props.isPrimary ? (
        <>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2 z-30 bg-background/90 text-muted-foreground opacity-0  backdrop-blur transition-opacity hover:bg-background hover:text-foreground group-hover/thread-pane:opacity-100 focus-visible:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            aria-label={`Close ${paneTitle}`}
          >
            <XIcon className="size-3.5" />
          </Button>
          <div
            className={cn(
              "pointer-events-none absolute inset-0 ring-1 ring-inset transition-colors",
              props.activePaneId === pane.id ? "ring-primary/35" : "ring-border/60",
            )}
          />
        </>
      ) : null}
    </div>
  );
}

export function ThreadBoard(props: {
  connectionUrl?: string | null;
  routeActiveThread?: ChatThreadBoardRoutePane | null;
  routeSplitId?: string | null;
  routeThreads?: readonly ChatThreadBoardRoutePane[];
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const rowGroupRefs = useRef(new Map<string, HTMLDivElement>());
  const activePaneId = useChatThreadBoardStore((state) => state.activePaneId);
  const paneRatios = useChatThreadBoardStore((state) => state.paneRatios);
  const panes = useChatThreadBoardStore((state) => state.panes);
  const rows = useChatThreadBoardStore((state) => state.rows);
  const closePane = useChatThreadBoardStore((state) => state.closePane);
  const openThreadInBoard = useChatThreadBoardStore((state) => state.openThreadInBoard);
  const setActivePane = useChatThreadBoardStore((state) => state.setActivePane);
  const setActiveSplit = useChatThreadBoardStore((state) => state.setActiveSplit);
  const setGridLayout = useChatThreadBoardStore((state) => state.setGridLayout);
  const setPaneRatios = useChatThreadBoardStore((state) => state.setPaneRatios);
  const setRowRatios = useChatThreadBoardStore((state) => state.setRowRatios);
  const syncRouteThread = useChatThreadBoardStore((state) => state.syncRouteThread);
  const syncRouteThreads = useChatThreadBoardStore((state) => state.syncRouteThreads);
  const routeThreads = props.routeThreads ?? EMPTY_ROUTE_THREADS;
  const activeRouteThread = useMemo<ChatThreadBoardRoutePane>(
    () =>
      props.routeActiveThread ?? {
        connectionUrl: props.connectionUrl ?? null,
        threadId: props.threadId,
      },
    [props.connectionUrl, props.routeActiveThread, props.threadId],
  );
  const splitRouteThreads = useMemo(
    () =>
      routeThreads.length > 1
        ? routeThreads.some((thread) => isSameRoutePane(thread, activeRouteThread))
          ? routeThreads
          : [...routeThreads, activeRouteThread]
        : EMPTY_ROUTE_THREADS,
    [activeRouteThread, routeThreads],
  );

  useEffect(() => {
    if (splitRouteThreads.length <= 1) {
      return;
    }
    setActiveSplit(props.routeSplitId ?? null);
    syncRouteThreads({
      activeThread: activeRouteThread,
      threads: splitRouteThreads,
    });
  }, [activeRouteThread, props.routeSplitId, setActiveSplit, splitRouteThreads, syncRouteThreads]);

  useEffect(() => {
    if (splitRouteThreads.length <= 1) {
      return;
    }
    const nextSearch = buildThreadBoardRouteSearch(splitRouteThreads, activeRouteThread, {
      splitId: props.routeSplitId ?? null,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: (previous) => {
          if (
            previous[THREAD_BOARD_ACTIVE_SEARCH_PARAM] ===
              nextSearch[THREAD_BOARD_ACTIVE_SEARCH_PARAM] &&
            previous[THREAD_BOARD_THREADS_SEARCH_PARAM] ===
              nextSearch[THREAD_BOARD_THREADS_SEARCH_PARAM] &&
            previous[THREAD_BOARD_SPLIT_SEARCH_PARAM] ===
              nextSearch[THREAD_BOARD_SPLIT_SEARCH_PARAM] &&
            previous[THREAD_ROUTE_CONNECTION_SEARCH_PARAM] ===
              nextSearch[THREAD_ROUTE_CONNECTION_SEARCH_PARAM]
          ) {
            return previous;
          }
          return {
            ...previous,
            ...nextSearch,
          };
        },
      });
    });
  }, [activeRouteThread, navigate, props.routeSplitId, props.threadId, splitRouteThreads]);

  const primaryPane = useMemo(
    () =>
      panes.find(
        (pane) =>
          pane.threadId === activeRouteThread.threadId &&
          (pane.connectionUrl ?? resolveLocalConnectionUrl()) ===
            (activeRouteThread.connectionUrl ?? resolveLocalConnectionUrl()),
      ),
    [activeRouteThread.connectionUrl, activeRouteThread.threadId, panes],
  );
  const normalizedRowRatios = useMemo(
    () => normalizePaneRatios(paneRatios, rows.length),
    [paneRatios, rows.length],
  );
  const paneById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
  const boardVisible = splitRouteThreads.length > 1 && panes.length > 1 && Boolean(primaryPane);
  const layoutOptions = useMemo(() => buildThreadBoardLayoutOptions(panes.length), [panes.length]);
  const currentLayoutColumns = useMemo(() => getCurrentLayoutColumns(rows), [rows]);
  const [dropTarget, setDropTarget] = useState<ThreadBoardDropTargetState | null>(null);

  const navigateToBoardRoute = useCallback(
    (activePane: ChatThreadBoardRoutePane) => {
      const boardState = useChatThreadBoardStore.getState();
      const routePanes = boardState.rows
        .flatMap((row) => row.paneIds)
        .map((paneId) => boardState.panes.find((pane) => pane.id === paneId))
        .filter((pane): pane is ChatThreadBoardPaneState => pane !== undefined);
      const seenPaneKeys = new Set(routePanes.map((pane) => getThreadBoardDragThreadKey(pane)));
      for (const pane of boardState.panes) {
        const paneKey = getThreadBoardDragThreadKey(pane);
        if (seenPaneKeys.has(paneKey)) {
          continue;
        }
        routePanes.push(pane);
        seenPaneKeys.add(paneKey);
      }
      if (routePanes.length <= 1) {
        return;
      }
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: activePane.threadId },
          search: buildThreadBoardRouteSearch(routePanes, activePane, {
            splitId: boardState.activeSplitId,
          }),
        });
      });
    },
    [navigate],
  );

  const promotePane = useCallback(
    (pane: ChatThreadBoardPaneState) => {
      setActivePane(pane.id);
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: pane.threadId },
          search: buildThreadBoardRouteSearch(panes, pane, { splitId: props.routeSplitId ?? null }),
        });
      });
    },
    [navigate, panes, props.routeSplitId, setActivePane],
  );

  const handleClosePane = useCallback(
    (pane: ChatThreadBoardPaneState) => {
      const nextPanes = panes.filter((candidate) => candidate.id !== pane.id);
      closePane(pane.id);
      if (nextPanes.length === 0) {
        return;
      }
      const nextActivePane =
        primaryPane && primaryPane.id !== pane.id ? primaryPane : (nextPanes[0] ?? null);
      if (!nextActivePane) {
        return;
      }
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: nextActivePane.threadId },
          replace: true,
          search: (previous) => ({
            ...previous,
            ...buildThreadBoardRouteSearch(nextPanes, nextActivePane, {
              splitId: props.routeSplitId ?? null,
            }),
          }),
        });
      });
    },
    [closePane, navigate, panes, primaryPane, props.routeSplitId],
  );
  const clearDropTarget = useCallback(() => {
    setDropTarget(null);
  }, []);
  const handlePaneDragLeave = useCallback(
    (paneId: string) => (event: ReactDragEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      setDropTarget((current) => (current?.paneId === paneId ? null : current));
    },
    [],
  );
  const handlePaneDragOver = useCallback(
    (pane: ChatThreadBoardPaneState) => (event: ReactDragEvent<HTMLDivElement>) => {
      const draggedThread = readThreadBoardDragThread(event.dataTransfer);
      if (!draggedThread) {
        return;
      }
      if (getThreadBoardDragThreadKey(draggedThread) === getThreadBoardDragThreadKey(pane)) {
        setDropTarget((current) => (current?.paneId === pane.id ? null : current));
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const direction = resolveThreadBoardDropDirection(
        event,
        event.currentTarget.getBoundingClientRect(),
      );
      setDropTarget((current) =>
        current &&
        current.paneId === pane.id &&
        current.direction === direction &&
        getThreadBoardDragThreadKey(current.thread) === getThreadBoardDragThreadKey(draggedThread)
          ? current
          : {
              direction,
              paneId: pane.id,
              thread: draggedThread,
            },
      );
    },
    [],
  );
  const handlePaneDrop = useCallback(
    (pane: ChatThreadBoardPaneState) => (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const draggedThread = readThreadBoardDragThread(event.dataTransfer);
      const direction =
        dropTarget?.paneId === pane.id
          ? dropTarget.direction
          : resolveThreadBoardDropDirection(event, event.currentTarget.getBoundingClientRect());
      clearDropTarget();
      if (!draggedThread) {
        return;
      }
      if (getThreadBoardDragThreadKey(draggedThread) === getThreadBoardDragThreadKey(pane)) {
        return;
      }

      const sourcePaneId = boardVisible ? pane.id : syncRouteThread(activeRouteThread);
      openThreadInBoard({
        connectionUrl: draggedThread.connectionUrl,
        direction,
        sourcePaneId,
        threadId: draggedThread.threadId,
      });
      navigateToBoardRoute({
        connectionUrl: draggedThread.connectionUrl,
        threadId: draggedThread.threadId,
      });
    },
    [
      activeRouteThread,
      boardVisible,
      clearDropTarget,
      dropTarget,
      navigateToBoardRoute,
      openThreadInBoard,
      syncRouteThread,
    ],
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

  useEffect(() => {
    const clear = () => {
      setDropTarget(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  useEffect(() => {
    const resetResizeInteractions = () => {
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

  if (!boardVisible || !primaryPane) {
    const singlePane: ChatThreadBoardPaneState = {
      connectionUrl: activeRouteThread.connectionUrl,
      id: "route-primary-pane",
      threadId: activeRouteThread.threadId,
    };
    return (
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background">
        <ThreadBoardPane
          activePaneId={singlePane.id}
          dropPreviewDirection={dropTarget?.paneId === singlePane.id ? dropTarget.direction : null}
          isPrimary
          isSinglePane
          pane={singlePane}
          shortcutsEnabled
          showSidebarTrigger
          splitPane={false}
          onClose={() => {}}
          onDragLeave={handlePaneDragLeave(singlePane.id)}
          onDragOver={handlePaneDragOver(singlePane)}
          onDrop={handlePaneDrop(singlePane)}
          onPromote={() => {}}
          setActivePane={() => {}}
        />
      </div>
    );
  }

  return (
    <div
      ref={boardRef}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div className="absolute right-3 bottom-3 z-40">
        <Menu>
          <MenuTrigger
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/90 px-2 text-xs font-medium text-muted-foreground  backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Change board layout"
          >
            <LayoutGridIcon className="size-3.5" />
            <span>{currentLayoutColumns} col</span>
          </MenuTrigger>
          <MenuPopup align="end" side="top" className="min-w-44">
            <MenuGroup>
              <MenuGroupLabel>Board layout</MenuGroupLabel>
              <MenuRadioGroup
                value={String(currentLayoutColumns)}
                onValueChange={(value) => {
                  const columns = Number(value);
                  if (!Number.isFinite(columns)) {
                    return;
                  }
                  setGridLayout({ columns });
                }}
              >
                {layoutOptions.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">
                        {option.columns === 1
                          ? "stack"
                          : option.rows === 1
                            ? "row"
                            : `${option.columns} cols`}
                      </span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </div>
      {rows.map((row, rowIndex) => (
        <div
          key={row.id}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
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
            className="flex h-full min-h-0 min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            {row.paneIds.map((paneId, paneIndex) => {
              const pane = paneById.get(paneId);
              if (!pane) {
                return null;
              }
              const isPrimary = pane.id === primaryPane.id;
              const showSidebarTrigger = rowIndex === 0 && paneIndex === 0;
              return (
                <div
                  key={pane.id}
                  className="flex h-full min-h-0 min-w-0 overflow-hidden"
                  style={{
                    flexBasis: 0,
                    flexGrow: row.paneRatios[paneIndex] ?? 1,
                    minWidth: `${BOARD_MIN_COLUMN_WIDTH_PX}px`,
                  }}
                >
                  <ThreadBoardPane
                    activePaneId={activePaneId}
                    dropPreviewDirection={
                      dropTarget?.paneId === pane.id ? dropTarget.direction : null
                    }
                    isPrimary={isPrimary}
                    isSinglePane={false}
                    pane={pane}
                    shortcutsEnabled={(activePaneId ?? primaryPane.id) === pane.id}
                    showSidebarTrigger={showSidebarTrigger}
                    onClose={() => {
                      handleClosePane(pane);
                    }}
                    onDragLeave={handlePaneDragLeave(pane.id)}
                    onDragOver={handlePaneDragOver(pane)}
                    onDrop={handlePaneDrop(pane)}
                    onPromote={() => {
                      promotePane(pane);
                    }}
                    setActivePane={setActivePane}
                  />
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
