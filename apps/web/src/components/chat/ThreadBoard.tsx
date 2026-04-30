import { type ThreadId } from "@ace/contracts";
import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";

import {
  orderBoardPanes,
  selectBoardPaneById,
  type ChatThreadBoardLayoutAxis,
  type ChatThreadBoardLayoutNode,
  type ChatThreadBoardPaneState,
  useChatThreadBoardStore,
} from "../../chatThreadBoardStore";
import ChatView from "../ChatView";
import { normalizePaneRatios, resizePaneRatios } from "../../lib/paneRatios";
import {
  THREAD_ROUTE_CONNECTION_SEARCH_PARAM,
  resolveLocalConnectionUrl,
} from "../../lib/connectionRouting";
import {
  THREAD_BOARD_ACTIVE_SEARCH_PARAM,
  THREAD_BOARD_PANE_SEARCH_PARAM,
  THREAD_BOARD_SPLIT_SEARCH_PARAM,
  THREAD_BOARD_THREADS_SEARCH_PARAM,
  buildThreadBoardRouteSearch,
  type ChatThreadBoardRoutePane,
} from "../../lib/chatThreadBoardRouteSearch";
import {
  getActiveThreadBoardDrag,
  getThreadBoardDragThreadKey,
  readThreadBoardDragThread,
  subscribeActiveThreadBoardDrag,
  THREAD_BOARD_DRAG_MIME,
  type ThreadBoardDragThread,
} from "../../lib/threadBoardDrag";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

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
          "pointer-events-none absolute z-[31] rounded-[inherit] border border-primary/45 bg-primary/[0.14]",
          props.direction === "left" || props.direction === "right"
            ? "top-0 bottom-0"
            : "left-0 right-0",
          frameClassName,
        )}
      />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-[32] flex justify-center">
        <div className="rounded-full border border-primary/30 bg-background/92 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-primary/85 uppercase backdrop-blur">
          {props.isSinglePane ? "Create split" : "Insert pane"} {props.direction}
        </div>
      </div>
    </>
  );
}

function ThreadBoardDropHint(props: { isSinglePane: boolean }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-20 rounded-[inherit] border border-dashed border-primary/30 bg-primary/[0.035]" />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-[32] flex justify-center">
        <div className="rounded-full border border-primary/25 bg-background/92 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-primary/80 uppercase backdrop-blur">
          {props.isSinglePane ? "Drop to create split" : "Drop to add pane"}
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

function isThreadBoardDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes(THREAD_BOARD_DRAG_MIME) ?? false;
}

function ThreadBoardPane(props: {
  activePaneId: string | null;
  dropPreviewDirection?: ThreadBoardDropDirection | null;
  isPrimary: boolean;
  isSinglePane: boolean;
  pane: ChatThreadBoardPaneState;
  shortcutsEnabled: boolean;
  showDropHint?: boolean;
  showDropOverlay?: boolean;
  showSidebarTrigger: boolean;
  splitPane?: boolean;
  onClose: () => void;
  onDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
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

      {props.showDropOverlay ? (
        <div
          className="absolute inset-0 z-20"
          onDragLeave={props.onDragLeave}
          onDragOver={props.onDragOver}
          onDrop={props.onDrop}
        />
      ) : null}

      {props.dropPreviewDirection ? (
        <ThreadBoardDropPreview
          direction={props.dropPreviewDirection}
          isSinglePane={props.isSinglePane}
        />
      ) : props.showDropHint ? (
        <ThreadBoardDropHint isSinglePane={props.isSinglePane} />
      ) : null}

      {!props.isPrimary ? (
        <>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2 z-30 bg-background/90 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:bg-background hover:text-foreground group-hover/thread-pane:opacity-100 focus-visible:opacity-100"
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
  routePaneId?: string | null;
  routeSplitId?: string | null;
  routeThreads?: readonly ChatThreadBoardRoutePane[];
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const branchRefs = useRef(new Map<string, HTMLDivElement>());
  const activePaneId = useChatThreadBoardStore((state) => state.activePaneId);
  const layoutRoot = useChatThreadBoardStore((state) => state.layoutRoot);
  const panes = useChatThreadBoardStore((state) => state.panes);
  const routeSplit = useChatThreadBoardStore((state) =>
    props.routeSplitId
      ? (state.splits.find((candidate) => candidate.id === props.routeSplitId) ?? null)
      : null,
  );
  const closePane = useChatThreadBoardStore((state) => state.closePane);
  const openThreadInBoard = useChatThreadBoardStore((state) => state.openThreadInBoard);
  const restoreSplit = useChatThreadBoardStore((state) => state.restoreSplit);
  const setActivePane = useChatThreadBoardStore((state) => state.setActivePane);
  const setActiveSplit = useChatThreadBoardStore((state) => state.setActiveSplit);
  const setBranchRatios = useChatThreadBoardStore((state) => state.setBranchRatios);
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
  const isSavedSplitRoute = Boolean(
    props.routeSplitId && routeSplit && routeSplit.archivedAt === null,
  );

  useEffect(() => {
    if (props.routeSplitId && routeSplit && routeSplit.archivedAt === null) {
      restoreSplit(props.routeSplitId, props.routePaneId ?? routeSplit.activePaneId);
      return;
    }
    if (splitRouteThreads.length <= 1) {
      return;
    }
    setActiveSplit(props.routeSplitId ?? null);
    syncRouteThreads({
      activeThread: activeRouteThread,
      threads: splitRouteThreads,
    });
  }, [
    activeRouteThread,
    props.routePaneId,
    props.routeSplitId,
    restoreSplit,
    routeSplit,
    setActiveSplit,
    splitRouteThreads,
    syncRouteThreads,
  ]);

  useEffect(() => {
    const activePane = selectBoardPaneById(panes, activePaneId);
    const isSplitRoute = Boolean(
      props.routeSplitId && routeSplit && routeSplit.archivedAt === null,
    );
    if (!isSplitRoute && splitRouteThreads.length <= 1) {
      return;
    }
    const nextSearch = buildThreadBoardRouteSearch(
      isSplitRoute ? [] : splitRouteThreads,
      isSplitRoute && activePane
        ? { connectionUrl: activePane.connectionUrl, threadId: activePane.threadId }
        : activeRouteThread,
      {
        paneId: isSplitRoute ? (activePane?.id ?? null) : null,
        splitId: isSplitRoute ? (props.routeSplitId ?? null) : null,
      },
    );
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: {
          threadId: isSplitRoute && activePane ? activePane.threadId : props.threadId,
        },
        replace: true,
        search: (previous) => {
          if (
            previous[THREAD_BOARD_ACTIVE_SEARCH_PARAM] ===
              nextSearch[THREAD_BOARD_ACTIVE_SEARCH_PARAM] &&
            previous[THREAD_BOARD_PANE_SEARCH_PARAM] ===
              nextSearch[THREAD_BOARD_PANE_SEARCH_PARAM] &&
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
  }, [
    activePaneId,
    activeRouteThread,
    navigate,
    panes,
    props.routeSplitId,
    props.threadId,
    routeSplit,
    splitRouteThreads,
  ]);

  const orderedPanes = useMemo(() => orderBoardPanes(panes, layoutRoot), [layoutRoot, panes]);
  const primaryPane = useMemo(
    () =>
      selectBoardPaneById(panes, activePaneId) ??
      panes.find(
        (pane) =>
          pane.threadId === activeRouteThread.threadId &&
          (pane.connectionUrl ?? resolveLocalConnectionUrl()) ===
            (activeRouteThread.connectionUrl ?? resolveLocalConnectionUrl()),
      ),
    [activePaneId, activeRouteThread.connectionUrl, activeRouteThread.threadId, panes],
  );
  const paneById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
  const firstPaneId = orderedPanes[0]?.id ?? null;
  const boardVisible =
    (isSavedSplitRoute || splitRouteThreads.length > 1) &&
    panes.length > 1 &&
    Boolean(primaryPane) &&
    layoutRoot !== null;
  const [dropTarget, setDropTarget] = useState<ThreadBoardDropTargetState | null>(null);
  const activeDraggedThread = useSyncExternalStore(
    subscribeActiveThreadBoardDrag,
    getActiveThreadBoardDrag,
    getActiveThreadBoardDrag,
  );
  const threadDragActive = activeDraggedThread !== null;

  const navigateToBoardRoute = useCallback(
    (activePane: ChatThreadBoardRoutePane) => {
      const boardState = useChatThreadBoardStore.getState();
      const routePanes = orderBoardPanes(boardState.panes, boardState.layoutRoot);
      if (routePanes.length <= 1) {
        return;
      }
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: activePane.threadId },
          search: buildThreadBoardRouteSearch(routePanes, activePane, {
            paneId: boardState.activePaneId,
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
          search: buildThreadBoardRouteSearch(panes, pane, {
            paneId: pane.id,
            splitId: props.routeSplitId ?? null,
          }),
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
              paneId: nextActivePane.id,
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

  const handleBoardDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
  }, []);

  const handleBoardDragOverCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
  }, []);

  const handleBoardDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setDropTarget(null);
  }, []);

  const handleBoardDropCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
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
      const draggedThread = readThreadBoardDragThread(event.dataTransfer) ?? activeDraggedThread;
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
    [activeDraggedThread],
  );

  const handlePaneDrop = useCallback(
    (pane: ChatThreadBoardPaneState) => (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const draggedThread = readThreadBoardDragThread(event.dataTransfer) ?? activeDraggedThread;
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
        allowDuplicate: true,
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
      activeDraggedThread,
      activeRouteThread,
      boardVisible,
      clearDropTarget,
      dropTarget,
      navigateToBoardRoute,
      openThreadInBoard,
      syncRouteThread,
    ],
  );

  const branchResizeStateRef = useRef<{
    axis: ChatThreadBoardLayoutAxis;
    branchId: string;
    dividerIndex: number;
    pointerId: number;
    startPosition: number;
    startRatios: number[];
  } | null>(null);

  const handleBranchResizeStart = useCallback(
    (branchId: string, axis: ChatThreadBoardLayoutAxis, dividerIndex: number) =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const branchNode = (function findBranch(
          node: ChatThreadBoardLayoutNode | null,
        ): ChatThreadBoardLayoutNode | null {
          if (!node) {
            return null;
          }
          if (node.kind === "split" && node.id === branchId) {
            return node;
          }
          if (node.kind === "pane") {
            return null;
          }
          for (const child of node.children) {
            const result = findBranch(child);
            if (result) {
              return result;
            }
          }
          return null;
        })(layoutRoot);
        if (!branchNode || branchNode.kind !== "split") {
          return;
        }
        branchResizeStateRef.current = {
          axis,
          branchId,
          dividerIndex,
          pointerId: event.pointerId,
          startPosition: axis === "horizontal" ? event.clientX : event.clientY,
          startRatios: normalizePaneRatios(branchNode.ratios, branchNode.children.length),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = axis === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      },
    [layoutRoot],
  );

  const handleBranchResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = branchResizeStateRef.current;
      const container = branchRefs.current.get(resizeState?.branchId ?? "") ?? null;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !container) {
        return;
      }
      event.preventDefault();
      const containerSize =
        resizeState.axis === "horizontal" ? container.clientWidth : container.clientHeight;
      const deltaPx =
        (resizeState.axis === "horizontal" ? event.clientX : event.clientY) -
        resizeState.startPosition;
      setBranchRatios(
        resizeState.branchId,
        resizePaneRatios({
          containerWidthPx: containerSize,
          deltaPx,
          dividerIndex: resizeState.dividerIndex,
          minPaneWidthPx:
            resizeState.axis === "horizontal" ? BOARD_MIN_COLUMN_WIDTH_PX : BOARD_MIN_ROW_HEIGHT_PX,
          ratios: resizeState.startRatios,
        }),
      );
    },
    [setBranchRatios],
  );

  const handleBranchResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = branchResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    branchResizeStateRef.current = null;
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
      branchResizeStateRef.current = null;
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

  const renderLeaf = useCallback(
    (paneId: string) => {
      const pane = paneById.get(paneId);
      if (!pane || !primaryPane) {
        return null;
      }
      return (
        <ThreadBoardPane
          key={pane.id}
          activePaneId={activePaneId}
          dropPreviewDirection={dropTarget?.paneId === pane.id ? dropTarget.direction : null}
          isPrimary={pane.id === primaryPane.id}
          isSinglePane={false}
          pane={pane}
          shortcutsEnabled={(activePaneId ?? primaryPane.id) === pane.id}
          showSidebarTrigger={pane.id === firstPaneId}
          showDropHint={threadDragActive && dropTarget?.paneId !== pane.id}
          showDropOverlay={threadDragActive}
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
      );
    },
    [
      activePaneId,
      dropTarget,
      firstPaneId,
      handleClosePane,
      handlePaneDragLeave,
      handlePaneDragOver,
      handlePaneDrop,
      paneById,
      primaryPane,
      promotePane,
      setActivePane,
      threadDragActive,
    ],
  );

  const renderLayoutNode = useCallback(
    (node: ChatThreadBoardLayoutNode | null): React.ReactNode => {
      if (!node) {
        return null;
      }
      if (node.kind === "pane") {
        return renderLeaf(node.paneId);
      }
      const ratios = normalizePaneRatios(node.ratios, node.children.length);
      return (
        <div
          ref={(element) => {
            if (element) {
              branchRefs.current.set(node.id, element);
            } else {
              branchRefs.current.delete(node.id);
            }
          }}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            node.axis === "horizontal" ? "flex-row" : "flex-col",
          )}
        >
          {node.children.map((child, index) => (
            <Fragment key={child.id}>
              <div
                className="flex min-h-0 min-w-0 overflow-hidden"
                style={{
                  flexBasis: 0,
                  flexGrow: ratios[index] ?? 1,
                  minHeight: node.axis === "vertical" ? `${BOARD_MIN_ROW_HEIGHT_PX}px` : undefined,
                  minWidth:
                    node.axis === "horizontal" ? `${BOARD_MIN_COLUMN_WIDTH_PX}px` : undefined,
                }}
              >
                {renderLayoutNode(child)}
              </div>
              {index < node.children.length - 1 ? (
                <div
                  role="separator"
                  aria-label={
                    node.axis === "horizontal" ? "Resize thread panes" : "Resize thread rows"
                  }
                  aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
                  className={cn(
                    "group relative z-10 shrink-0 touch-none select-none",
                    node.axis === "horizontal"
                      ? "-mx-px flex w-2 cursor-col-resize items-center justify-center"
                      : "-my-px flex h-2 cursor-row-resize items-center justify-center",
                  )}
                  onPointerDown={handleBranchResizeStart(node.id, node.axis, index)}
                  onPointerMove={handleBranchResizeMove}
                  onPointerUp={handleBranchResizeEnd}
                  onPointerCancel={handleBranchResizeEnd}
                >
                  <div
                    className={cn(
                      "absolute bg-border/70 transition-colors group-hover:bg-foreground/30",
                      node.axis === "horizontal"
                        ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                        : "inset-x-0 top-1/2 h-px -translate-y-1/2",
                    )}
                  />
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      );
    },
    [handleBranchResizeEnd, handleBranchResizeMove, handleBranchResizeStart, renderLeaf],
  );

  if (!boardVisible || !primaryPane) {
    const singlePane: ChatThreadBoardPaneState = {
      connectionUrl: activeRouteThread.connectionUrl,
      id: "route-primary-pane",
      threadId: activeRouteThread.threadId,
    };
    return (
      <div
        className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background"
        onDragEnter={handleBoardDragEnter}
        onDragLeave={handleBoardDragLeave}
        onDragOverCapture={handleBoardDragOverCapture}
        onDropCapture={handleBoardDropCapture}
      >
        <ThreadBoardPane
          activePaneId={singlePane.id}
          dropPreviewDirection={dropTarget?.paneId === singlePane.id ? dropTarget.direction : null}
          isPrimary
          isSinglePane
          pane={singlePane}
          shortcutsEnabled
          showSidebarTrigger
          showDropHint={threadDragActive}
          showDropOverlay={threadDragActive}
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
      className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background"
      onDragEnter={handleBoardDragEnter}
      onDragLeave={handleBoardDragLeave}
      onDragOverCapture={handleBoardDragOverCapture}
      onDropCapture={handleBoardDropCapture}
    >
      {renderLayoutNode(layoutRoot)}
    </div>
  );
}
