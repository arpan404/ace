import { type ThreadId } from "@ace/contracts";
import {
  Fragment,
  type ReactNode,
  startTransition,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";

import {
  orderBoardPanes,
  selectBoardPaneById,
  type ChatThreadBoardLayoutAxis,
  type ChatThreadBoardLayoutNode,
  type ChatThreadBoardPaneState,
  useChatThreadBoardStore,
} from "../../chatThreadBoardStore";
import { normalizePaneRatios, resizePaneRatios } from "../../lib/paneRatios";
import { THREAD_BOARD_LAYOUT_ACTIVE_CLASS_NAME } from "../../lib/desktopChrome";
import { buildSingleThreadRouteSearch } from "../../lib/chatThreadBoardRouteSearch";
import { useEffectEvent } from "../../hooks/useEffectEvent";
import {
  createThreadBoardDragThread,
  encodeThreadBoardDragThread,
  getActiveThreadBoardDrag,
  getThreadBoardDragThreadKey,
  readThreadBoardDragThread,
  setActiveThreadBoardDrag,
  setThreadBoardDragImage,
  THREAD_BOARD_DRAG_MIME,
  type ThreadBoardDragThread,
} from "../../lib/threadBoardDrag";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { useStore } from "../../store";
import { cn } from "~/lib/utils";
import { buildThreadBoardTitle } from "../../lib/threadBoardTitle";
import { ThreadBoardPane } from "./ThreadBoardPane";
import type { ThreadBoardDropDirection } from "./threadBoardTypes";

const BOARD_MIN_COLUMN_WIDTH_PX = 360;
const BOARD_MIN_ROW_HEIGHT_PX = 240;
const BOARD_DEFER_CONTENT_FRAME_COUNT = 2;

interface ThreadBoardDropTargetState {
  direction: ThreadBoardDropDirection;
  paneId: string;
  thread: ThreadBoardDragThread;
  threadKey: string;
}

const NO_OP_THREAD_BOARD_CLOSE_PANE = (_pane: ChatThreadBoardPaneState) => {};
const NO_OP_THREAD_BOARD_SET_ACTIVE_PANE = (_paneId: string) => {};

function handleThreadBoardDragEnter(event: ReactDragEvent<HTMLDivElement>) {
  if (!isThreadBoardDrag(event.dataTransfer)) {
    return;
  }
}

function handleThreadBoardDragOverCapture(event: ReactDragEvent<HTMLDivElement>) {
  if (!isThreadBoardDrag(event.dataTransfer)) {
    return;
  }
}

function applyBranchResizePreview(children: readonly HTMLElement[], ratios: readonly number[]) {
  for (const [index, child] of children.entries()) {
    child.style.flexGrow = String(ratios[index] ?? 1);
  }
}

function clearDeferredPaneContentFrames(frameIdsRef: { current: number[] }) {
  for (const frameId of frameIdsRef.current) {
    window.cancelAnimationFrame(frameId);
  }
  frameIdsRef.current = [];
}

type ThreadBoardLayoutNodeRendererProps = {
  node: ChatThreadBoardLayoutNode | null;
  renderPaneNode: (paneId: string) => ReactNode;
  branchRefs: { current: Map<string, HTMLDivElement> };
  handleBranchResizeStart: (
    branchId: string,
    axis: ChatThreadBoardLayoutAxis,
    index: number,
  ) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleBranchResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleBranchResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

function ThreadBoardLayoutNode({
  node,
  renderPaneNode,
  branchRefs,
  handleBranchResizeStart,
  handleBranchResizeMove,
  handleBranchResizeEnd,
}: ThreadBoardLayoutNodeRendererProps): ReactNode {
  if (!node) {
    return null;
  }
  if (node.kind === "pane") {
    return renderPaneNode(node.paneId);
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
            data-thread-board-branch-child="true"
            style={{
              flexBasis: 0,
              flexGrow: ratios[index] ?? 1,
              minHeight: node.axis === "vertical" ? `${BOARD_MIN_ROW_HEIGHT_PX}px` : undefined,
              minWidth: node.axis === "horizontal" ? `${BOARD_MIN_COLUMN_WIDTH_PX}px` : undefined,
            }}
          >
            <ThreadBoardLayoutNode
              node={child}
              renderPaneNode={renderPaneNode}
              branchRefs={branchRefs}
              handleBranchResizeStart={handleBranchResizeStart}
              handleBranchResizeMove={handleBranchResizeMove}
              handleBranchResizeEnd={handleBranchResizeEnd}
            />
          </div>
          {index < node.children.length - 1 ? (
            <hr
              aria-label={node.axis === "horizontal" ? "Resize thread panes" : "Resize thread rows"}
              aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
              className={cn(
                "group relative z-10 shrink-0 touch-none select-none border-0 bg-transparent outline-none transition-[background-color] duration-150 before:absolute before:rounded-full before:bg-primary/0 before:transition-[background-color,transform,opacity] before:duration-150 before:ease-out before:content-[''] after:absolute after:bg-border/55 after:transition-colors after:duration-150 after:content-[''] hover:before:bg-primary/10 hover:after:bg-primary/45 focus-visible:before:bg-primary/10 focus-visible:after:bg-primary/45 active:before:bg-primary/15 active:after:bg-primary/60",
                node.axis === "horizontal"
                  ? "-mx-px h-auto w-2 cursor-col-resize before:inset-y-2 before:left-1/2 before:w-1 before:-translate-x-1/2 hover:before:scale-x-125 after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2"
                  : "-my-px h-2 cursor-row-resize before:inset-x-2 before:top-1/2 before:h-1 before:-translate-y-1/2 hover:before:scale-y-125 after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2",
              )}
              onPointerDown={handleBranchResizeStart(node.id, node.axis, index)}
              onPointerMove={handleBranchResizeMove}
              onPointerUp={handleBranchResizeEnd}
              onPointerCancel={handleBranchResizeEnd}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
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

function isThreadBoardDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes(THREAD_BOARD_DRAG_MIME) ?? false;
}

function useThreadBoardComponent(props: { connectionUrl?: string | null; threadId: ThreadId }) {
  const navigate = useNavigate();
  const branchRefs = useRef<Map<string, HTMLDivElement>>(null!);
  if (branchRefs.current === null) {
    branchRefs.current = new Map<string, HTMLDivElement>();
  }
  const activePaneId = useChatThreadBoardStore((state) => state.activePaneId);
  const activeSplitId = useChatThreadBoardStore((state) => state.activeSplitId);
  const layoutRoot = useChatThreadBoardStore((state) => state.layoutRoot);
  const panes = useChatThreadBoardStore((state) => state.panes);
  const savedSplitCount = useChatThreadBoardStore((state) => state.splits.length);
  const closePane = useChatThreadBoardStore((state) => state.closePane);
  const movePane = useChatThreadBoardStore((state) => state.movePane);
  const openThreadInBoard = useChatThreadBoardStore((state) => state.openThreadInBoard);
  const setActivePane = useChatThreadBoardStore((state) => state.setActivePane);
  const setBranchRatios = useChatThreadBoardStore((state) => state.setBranchRatios);
  const syncRouteThread = useChatThreadBoardStore((state) => state.syncRouteThread);
  const routeSidebarThread = useSidebarThreadSummaryById(props.threadId);
  const activeRouteThread = {
    connectionUrl: props.connectionUrl ?? null,
    threadId: props.threadId,
    title: routeSidebarThread?.title ?? null,
  };
  const orderedPanes = orderBoardPanes(panes, layoutRoot);
  const visibleBoardThreadIds = orderedPanes.map((pane) => pane.threadId);
  const primaryPane = selectBoardPaneById(panes, activePaneId) ?? orderedPanes[0];
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const firstPaneId = orderedPanes[0]?.id ?? null;
  const boardVisible =
    activeSplitId !== null && panes.length > 1 && Boolean(primaryPane) && layoutRoot !== null;
  const boardRootClassName = "relative flex h-full min-h-0 flex-1 overflow-hidden bg-background";

  useEffect(() => {
    document.documentElement.classList.toggle(THREAD_BOARD_LAYOUT_ACTIVE_CLASS_NAME, boardVisible);
    return () => {
      document.documentElement.classList.remove(THREAD_BOARD_LAYOUT_ACTIVE_CLASS_NAME);
    };
  }, [boardVisible]);

  const [dropTarget, setDropTarget] = useState<ThreadBoardDropTargetState | null>(null);
  const dropTargetRef = useRef<ThreadBoardDropTargetState | null>(null);
  const paneDropRectCacheRef = useRef<Map<string, DOMRect>>(null!);
  if (paneDropRectCacheRef.current === null) {
    paneDropRectCacheRef.current = new Map<string, DOMRect>();
  }
  const [deferredPaneContentIds, setDeferredPaneContentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const deferredPaneContentFrameIdsRef = useRef<number[]>([]);

  const deferPaneContentMount = (paneIds: ReadonlyArray<string | null | undefined>) => {
    const ids = paneIds.filter((paneId): paneId is string => Boolean(paneId));
    if (ids.length === 0) {
      return;
    }
    clearDeferredPaneContentFrames(deferredPaneContentFrameIdsRef);
    setDeferredPaneContentIds(new Set(ids));

    let remainingFrames = BOARD_DEFER_CONTENT_FRAME_COUNT;
    const scheduleNextFrame = () => {
      const frameId = window.requestAnimationFrame(() => {
        deferredPaneContentFrameIdsRef.current = deferredPaneContentFrameIdsRef.current.filter(
          (id) => id !== frameId,
        );
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          scheduleNextFrame();
          return;
        }
        startTransition(() => {
          setDeferredPaneContentIds(new Set());
        });
      });
      deferredPaneContentFrameIdsRef.current.push(frameId);
    };
    scheduleNextFrame();
  };

  useEffect(
    () => () => {
      clearDeferredPaneContentFrames(deferredPaneContentFrameIdsRef);
    },
    [],
  );

  const navigateToSingleThreadRoute = (pane: {
    connectionUrl: string | null;
    threadId: ThreadId;
  }) => {
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: pane.threadId },
        replace: true,
        search: buildSingleThreadRouteSearch({ connectionUrl: pane.connectionUrl }),
      });
    });
  };

  const buildBoardTitle = (
    threads: ReadonlyArray<{ threadId: ThreadId; title?: string | null | undefined }>,
  ) =>
    buildThreadBoardTitle({
      fallbackIndex: savedSplitCount + 1,
      threads: threads.map((thread) => ({
        threadId: thread.threadId,
        title:
          thread.title ?? useStore.getState().sidebarThreadsById[thread.threadId]?.title ?? null,
      })),
    });

  const handleClosePane = (pane: ChatThreadBoardPaneState) => {
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
    if (nextPanes.length <= 1) {
      navigateToSingleThreadRoute(nextActivePane);
    }
  };

  const clearDropTarget = () => {
    paneDropRectCacheRef.current.clear();
    if (dropTargetRef.current === null) {
      return;
    }
    dropTargetRef.current = null;
    setDropTarget(null);
  };
  const clearDropTargetEvent = useEffectEvent(clearDropTarget);

  const handleBoardDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    clearDropTarget();
  };

  const handleBoardDropCapture = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isThreadBoardDrag(event.dataTransfer)) {
      return;
    }
    clearDropTarget();
  };

  const handlePaneDragLeave = (paneId: string, event: ReactDragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    if (dropTargetRef.current?.paneId !== paneId) {
      return;
    }
    dropTargetRef.current = null;
    setDropTarget(null);
  };

  const updatePaneDropTarget = (
    pane: ChatThreadBoardPaneState,
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    const draggedThread =
      getActiveThreadBoardDrag() ?? readThreadBoardDragThread(event.dataTransfer);
    if (!draggedThread) {
      return false;
    }
    const sourcePaneId = draggedThread.sourcePaneId ?? null;
    const draggedThreadKey = getThreadBoardDragThreadKey(draggedThread);
    const isSamePaneDrag = sourcePaneId === pane.id;
    const isSameSidebarThreadDrop =
      sourcePaneId === null && draggedThreadKey === getThreadBoardDragThreadKey(pane);
    if (isSamePaneDrag || isSameSidebarThreadDrop) {
      if (dropTargetRef.current?.paneId === pane.id) {
        dropTargetRef.current = null;
        setDropTarget(null);
      }
      return false;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = sourcePaneId ? "move" : "copy";
    const rect =
      paneDropRectCacheRef.current.get(pane.id) ?? event.currentTarget.getBoundingClientRect();
    paneDropRectCacheRef.current.set(pane.id, rect);
    const direction = resolveThreadBoardDropDirection(event, rect);
    const currentDropTarget = dropTargetRef.current;
    if (
      currentDropTarget &&
      currentDropTarget.paneId === pane.id &&
      currentDropTarget.direction === direction &&
      currentDropTarget.threadKey === draggedThreadKey
    ) {
      return true;
    }
    const nextDropTarget = {
      direction,
      paneId: pane.id,
      thread: draggedThread,
      threadKey: draggedThreadKey,
    };
    dropTargetRef.current = nextDropTarget;
    setDropTarget(nextDropTarget);
    return true;
  };

  const handlePaneDragEnter = (
    pane: ChatThreadBoardPaneState,
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    updatePaneDropTarget(pane, event);
  };

  const handlePaneDragOver = (
    pane: ChatThreadBoardPaneState,
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    updatePaneDropTarget(pane, event);
  };

  const handlePaneDrop = (
    pane: ChatThreadBoardPaneState,
    event: ReactDragEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedThread =
      getActiveThreadBoardDrag() ?? readThreadBoardDragThread(event.dataTransfer);
    const currentDropTarget = dropTargetRef.current;
    const rect =
      paneDropRectCacheRef.current.get(pane.id) ?? event.currentTarget.getBoundingClientRect();
    const direction =
      currentDropTarget?.paneId === pane.id
        ? currentDropTarget.direction
        : resolveThreadBoardDropDirection(event, rect);
    clearDropTarget();
    setActiveThreadBoardDrag(null);
    if (!draggedThread) {
      return;
    }
    const sourcePaneId = draggedThread.sourcePaneId ?? null;
    if (sourcePaneId === pane.id) {
      return;
    }

    if (sourcePaneId) {
      const movedPaneId = movePane({
        direction,
        paneId: sourcePaneId,
        targetPaneId: pane.id,
      });
      if (movedPaneId) {
        deferPaneContentMount([movedPaneId]);
      }
      return;
    }

    if (getThreadBoardDragThreadKey(draggedThread) === getThreadBoardDragThreadKey(pane)) {
      return;
    }

    const insertionSourcePaneId = boardVisible ? pane.id : syncRouteThread(activeRouteThread);
    const boardTitle = boardVisible
      ? undefined
      : buildBoardTitle([
          {
            threadId: activeRouteThread.threadId,
            title:
              useStore.getState().sidebarThreadsById[activeRouteThread.threadId]?.title ?? null,
          },
          draggedThread,
        ]);
    const openedPaneId = openThreadInBoard({
      connectionUrl: draggedThread.connectionUrl,
      direction,
      paneTitle: draggedThread.title ?? null,
      sourcePaneId: insertionSourcePaneId,
      splitTitle: boardTitle,
      threadId: draggedThread.threadId,
    });
    deferPaneContentMount(boardVisible ? [openedPaneId] : [insertionSourcePaneId, openedPaneId]);
  };

  const handlePaneDragStart = (
    pane: ChatThreadBoardPaneState,
    label: string,
    event: ReactDragEvent<HTMLButtonElement>,
  ) => {
    const dragThread = createThreadBoardDragThread({
      connectionUrl: pane.connectionUrl,
      sourcePaneId: pane.id,
      threadId: pane.threadId,
      title: label,
    });
    const payload = encodeThreadBoardDragThread(dragThread);
    event.stopPropagation();
    paneDropRectCacheRef.current.clear();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(THREAD_BOARD_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", payload);
    setThreadBoardDragImage(event.dataTransfer, { label, tone: "move" });
    setActiveThreadBoardDrag(dragThread);
    setActivePane(pane.id);
  };

  const handlePaneDragEnd = () => {
    setActiveThreadBoardDrag(null);
    clearDropTarget();
  };

  const branchResizeStateRef = useRef<{
    axis: ChatThreadBoardLayoutAxis;
    branchId: string;
    dividerIndex: number;
    pendingRatios: number[];
    pointerId: number;
    previewChildren: HTMLElement[];
    rafId: number | null;
    startPosition: number;
    startRatios: number[];
    startSize: number;
  } | null>(null);

  const resetBranchResizeInteractions = useEffectEvent(() => {
    const resizeState = branchResizeStateRef.current;
    if (resizeState?.rafId !== null && resizeState?.rafId !== undefined) {
      window.cancelAnimationFrame(resizeState.rafId);
    }
    if (resizeState) {
      applyBranchResizePreview(resizeState.previewChildren, resizeState.pendingRatios);
      setBranchRatios(resizeState.branchId, resizeState.pendingRatios);
      branchResizeStateRef.current = null;
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  });

  const handleBranchResizeStart =
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
      const container = branchRefs.current.get(branchId);
      if (!container) {
        return;
      }
      const previewChildren = Array.from(container.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.dataset.threadBoardBranchChild === "true",
      );
      const startSize = axis === "horizontal" ? container.clientWidth : container.clientHeight;
      branchResizeStateRef.current = {
        axis,
        branchId,
        dividerIndex,
        pendingRatios: normalizePaneRatios(branchNode.ratios, branchNode.children.length),
        pointerId: event.pointerId,
        previewChildren,
        rafId: null,
        startPosition: axis === "horizontal" ? event.clientX : event.clientY,
        startRatios: normalizePaneRatios(branchNode.ratios, branchNode.children.length),
        startSize,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      Object.assign(document.body.style, {
        cursor: axis === "horizontal" ? "col-resize" : "row-resize",
        userSelect: "none",
      });
    };

  const handleBranchResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = branchResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const deltaPx =
      (resizeState.axis === "horizontal" ? event.clientX : event.clientY) -
      resizeState.startPosition;
    resizeState.pendingRatios = resizePaneRatios({
      containerWidthPx: resizeState.startSize,
      deltaPx,
      dividerIndex: resizeState.dividerIndex,
      minPaneWidthPx:
        resizeState.axis === "horizontal" ? BOARD_MIN_COLUMN_WIDTH_PX : BOARD_MIN_ROW_HEIGHT_PX,
      ratios: resizeState.startRatios,
    });
    if (resizeState.rafId !== null) {
      return;
    }
    resizeState.rafId = window.requestAnimationFrame(() => {
      const currentResizeState = branchResizeStateRef.current;
      if (!currentResizeState) {
        return;
      }
      currentResizeState.rafId = null;
      applyBranchResizePreview(
        currentResizeState.previewChildren,
        currentResizeState.pendingRatios,
      );
    });
  };

  const handleBranchResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = branchResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    if (resizeState.rafId !== null) {
      window.cancelAnimationFrame(resizeState.rafId);
    }
    applyBranchResizePreview(resizeState.previewChildren, resizeState.pendingRatios);
    setBranchRatios(resizeState.branchId, resizeState.pendingRatios);
    branchResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };

  useEffect(() => {
    const clear = () => {
      clearDropTargetEvent();
      setActiveThreadBoardDrag(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetBranchResizeInteractions();
      }
    };
    window.addEventListener("blur", resetBranchResizeInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetBranchResizeInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [setBranchRatios]);

  const renderPaneNode = (paneId: string) => {
    const pane = paneById.get(paneId);
    if (!pane || !primaryPane) {
      return null;
    }
    return (
      <ThreadBoardPane
        key={pane.id}
        chatState={{
          shortcutsEnabled: (activePaneId ?? primaryPane.id) === pane.id,
          showSidebarTrigger: pane.id === firstPaneId,
          visibleBoardThreadIds,
        }}
        dropPreviewDirection={dropTarget?.paneId === pane.id ? dropTarget.direction : null}
        pane={pane}
        visualState={{
          deferContent: deferredPaneContentIds.has(pane.id),
          isFocusedPane: (activePaneId ?? primaryPane.id) === pane.id,
          isSinglePane: false,
        }}
        onClosePane={handleClosePane}
        onPaneDragEnter={handlePaneDragEnter}
        onPaneDragLeave={handlePaneDragLeave}
        onPaneDragOver={handlePaneDragOver}
        onPaneDrop={handlePaneDrop}
        onPaneDragEnd={handlePaneDragEnd}
        onPaneDragStart={handlePaneDragStart}
        setActivePane={setActivePane}
      />
    );
  };

  if (!boardVisible || !primaryPane) {
    const singlePane: ChatThreadBoardPaneState = {
      connectionUrl: activeRouteThread.connectionUrl,
      id: "route-primary-pane",
      threadId: activeRouteThread.threadId,
      title: activeRouteThread.title ?? "Untitled thread",
    };
    return (
      <LazyMotion features={domAnimation}>
        <div
          className={boardRootClassName}
          onDragEnter={handleThreadBoardDragEnter}
          onDragLeave={handleBoardDragLeave}
          onDragOverCapture={handleThreadBoardDragOverCapture}
          onDropCapture={handleBoardDropCapture}
        >
          <ThreadBoardPane
            chatState={{
              shortcutsEnabled: true,
              showSidebarTrigger: true,
              splitPane: false,
            }}
            dropPreviewDirection={
              dropTarget?.paneId === singlePane.id ? dropTarget.direction : null
            }
            pane={singlePane}
            showDropHint={dropTarget?.paneId !== singlePane.id}
            visualState={{
              deferContent: false,
              isFocusedPane: true,
              isSinglePane: true,
            }}
            onClosePane={NO_OP_THREAD_BOARD_CLOSE_PANE}
            onPaneDragEnter={handlePaneDragEnter}
            onPaneDragLeave={handlePaneDragLeave}
            onPaneDragOver={handlePaneDragOver}
            onPaneDrop={handlePaneDrop}
            setActivePane={NO_OP_THREAD_BOARD_SET_ACTIVE_PANE}
          />
        </div>
      </LazyMotion>
    );
  }

  return (
    <LazyMotion features={domAnimation}>
      <div
        className={boardRootClassName}
        onDragEnter={handleThreadBoardDragEnter}
        onDragLeave={handleBoardDragLeave}
        onDragOverCapture={handleThreadBoardDragOverCapture}
        onDropCapture={handleBoardDropCapture}
      >
        <ThreadBoardLayoutNode
          node={layoutRoot}
          renderPaneNode={renderPaneNode}
          branchRefs={branchRefs}
          handleBranchResizeStart={handleBranchResizeStart}
          handleBranchResizeMove={handleBranchResizeMove}
          handleBranchResizeEnd={handleBranchResizeEnd}
        />
      </div>
    </LazyMotion>
  );
}

export function ThreadBoard(props: { connectionUrl?: string | null; threadId: ThreadId }) {
  return useThreadBoardComponent(props);
}
