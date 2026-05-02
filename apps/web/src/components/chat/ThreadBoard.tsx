import { type ThreadId } from "@ace/contracts";
import {
  Fragment,
  memo,
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
import { GripVerticalIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

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
import { THREAD_BOARD_LAYOUT_ACTIVE_CLASS_NAME } from "../../lib/desktopChrome";
import { buildSingleThreadRouteSearch } from "../../lib/chatThreadBoardRouteSearch";
import {
  createThreadBoardDragThread,
  encodeThreadBoardDragThread,
  getActiveThreadBoardDrag,
  getThreadBoardDragThreadKey,
  readThreadBoardDragThread,
  setActiveThreadBoardDrag,
  setThreadBoardDragImage,
  subscribeActiveThreadBoardDrag,
  THREAD_BOARD_DRAG_MIME,
  type ThreadBoardDragThread,
} from "../../lib/threadBoardDrag";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { useStore } from "../../store";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { buildThreadBoardTitle } from "../../lib/threadBoardTitle";

const BOARD_MIN_COLUMN_WIDTH_PX = 360;
const BOARD_MIN_ROW_HEIGHT_PX = 240;
const BOARD_DROP_TRANSITION = { duration: 0.07, ease: [0.16, 1, 0.3, 1] } as const;
const BOARD_REDUCED_MOTION_TRANSITION = { duration: 0 } as const;
const BOARD_DEFER_CONTENT_FRAME_COUNT = 2;
const EMPTY_VISIBLE_BOARD_THREAD_IDS: readonly ThreadId[] = [];
type ThreadBoardDropDirection = "down" | "left" | "right" | "up";

interface ThreadBoardDropTargetState {
  direction: ThreadBoardDropDirection;
  paneId: string;
  thread: ThreadBoardDragThread;
  threadKey: string;
}

type ThreadBoardPaneDragHandler = (
  pane: ChatThreadBoardPaneState,
  event: ReactDragEvent<HTMLDivElement>,
) => void;
type ThreadBoardPaneDragLeaveHandler = (
  paneId: string,
  event: ReactDragEvent<HTMLDivElement>,
) => void;
type ThreadBoardPaneDragStartHandler = (
  pane: ChatThreadBoardPaneState,
  label: string,
  event: ReactDragEvent<HTMLButtonElement>,
) => void;

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

function ThreadBoardDropPreview(props: { direction: ThreadBoardDropDirection }) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? BOARD_REDUCED_MOTION_TRANSITION : BOARD_DROP_TRANSITION;
  const frameClassName =
    props.direction === "left"
      ? "right-1/2 w-1/2"
      : props.direction === "right"
        ? "left-1/2 w-1/2"
        : props.direction === "up"
          ? "bottom-1/2 h-1/2"
          : "top-1/2 h-1/2";

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-30 rounded-[inherit]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
      aria-hidden="true"
    >
      <div className="absolute inset-0 rounded-[inherit] border border-primary/28 bg-primary/[0.04]" />
      <motion.div
        className={cn(
          "absolute z-[31] rounded-[inherit] border border-primary/40 bg-primary/[0.12] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.06)]",
          props.direction === "left" || props.direction === "right"
            ? "top-0 bottom-0"
            : "left-0 right-0",
          frameClassName,
        )}
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99 }}
        transition={transition}
      />
    </motion.div>
  );
}

function ThreadBoardDropHint(props: { isSinglePane: boolean }) {
  const reducedMotion = useReducedMotion();
  const transition = reducedMotion ? BOARD_REDUCED_MOTION_TRANSITION : BOARD_DROP_TRANSITION;
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-20 rounded-[inherit]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transition}
      aria-hidden="true"
    >
      <div className="absolute inset-0 rounded-[inherit] border border-dashed border-primary/28 bg-primary/[0.03]" />
      <motion.div
        className="absolute inset-x-3 top-3 z-[32] flex justify-center"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -2 }}
        transition={transition}
      >
        <div className="rounded-full border border-primary/25 bg-background/92 px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-primary/80 uppercase backdrop-blur">
          {props.isSinglePane ? "Drop to create split" : "Drop to add pane"}
        </div>
      </motion.div>
    </motion.div>
  );
}

function isThreadBoardDrag(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes(THREAD_BOARD_DRAG_MIME) ?? false;
}

function useThreadBoardDragActive(): boolean {
  return (
    useSyncExternalStore(
      subscribeActiveThreadBoardDrag,
      getActiveThreadBoardDrag,
      getActiveThreadBoardDrag,
    ) !== null
  );
}

const ThreadBoardPaneContent = memo(function ThreadBoardPaneContent(props: {
  deferContent: boolean;
  isDimmedPane: boolean;
  isFocusedPane: boolean;
  isSinglePane: boolean;
  pane: ChatThreadBoardPaneState;
  shortcutsEnabled: boolean;
  showSidebarTrigger: boolean;
  splitPane: boolean | undefined;
  visibleBoardThreadIds: ReadonlyArray<ThreadId>;
  onClosePane: (pane: ChatThreadBoardPaneState) => void;
  onPaneDragEnd: ((event: ReactDragEvent<HTMLButtonElement>) => void) | undefined;
  onPaneDragStart: ThreadBoardPaneDragStartHandler | undefined;
}) {
  const { pane } = props;
  const sidebarThread = useSidebarThreadSummaryById(pane.threadId);
  const paneTitle = sidebarThread?.title ?? "thread";
  const className = cn(
    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
    props.isDimmedPane ? "opacity-92 saturate-[0.92] brightness-[1] contrast-[1]" : "opacity-100",
  );

  if (props.deferContent) {
    return <div aria-hidden="true" className={className} />;
  }

  return (
    <div className={className}>
      <ChatView
        activeInBoard={props.isFocusedPane}
        connectionUrl={pane.connectionUrl}
        paneControls={
          !props.isSinglePane ? (
            <>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                draggable
                className="no-drag-region h-7 w-7 cursor-pointer text-muted-foreground/55 opacity-80 transition-[background-color,color,opacity,transform] duration-150 hover:-translate-y-px hover:text-foreground hover:opacity-100 active:cursor-grabbing active:translate-y-0"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onDragStart={(event) => {
                  props.onPaneDragStart?.(pane, paneTitle, event);
                }}
                onDragEnd={props.onPaneDragEnd}
                aria-label={`Move ${paneTitle}`}
              >
                <GripVerticalIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="no-drag-region h-7 w-7 text-muted-foreground/55 opacity-80 transition-[background-color,color,opacity,transform] duration-150 hover:-translate-y-px hover:text-foreground hover:opacity-100 active:translate-y-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClosePane(pane);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                aria-label={`Close ${paneTitle}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </>
          ) : null
        }
        threadId={pane.threadId}
        shortcutsEnabled={props.shortcutsEnabled}
        showSidebarTrigger={props.showSidebarTrigger}
        splitPane={props.splitPane ?? true}
        visibleBoardThreadIds={props.visibleBoardThreadIds}
      />
    </div>
  );
});

const ThreadBoardPaneDropLayer = memo(function ThreadBoardPaneDropLayer(props: {
  dropPreviewDirection: ThreadBoardDropDirection | null | undefined;
  isSinglePane: boolean;
  pane: ChatThreadBoardPaneState;
  showDropHint: boolean | undefined;
  onPaneDragEnter: ThreadBoardPaneDragHandler | undefined;
  onPaneDragLeave: ThreadBoardPaneDragLeaveHandler | undefined;
  onPaneDragOver: ThreadBoardPaneDragHandler | undefined;
  onPaneDrop: ThreadBoardPaneDragHandler | undefined;
}) {
  const dragActive = useThreadBoardDragActive();
  const { pane } = props;

  return (
    <>
      {dragActive ? (
        <div
          className="absolute inset-0 z-20"
          onDragEnter={
            props.onPaneDragEnter
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragEnter?.(pane, event);
                }
              : undefined
          }
          onDragLeave={
            props.onPaneDragLeave
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragLeave?.(pane.id, event);
                }
              : undefined
          }
          onDragOver={
            props.onPaneDragOver
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragOver?.(pane, event);
                }
              : undefined
          }
          onDrop={
            props.onPaneDrop
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDrop?.(pane, event);
                }
              : undefined
          }
        />
      ) : null}

      <AnimatePresence initial={false}>
        {props.dropPreviewDirection ? (
          <ThreadBoardDropPreview key="drop-preview" direction={props.dropPreviewDirection} />
        ) : dragActive && props.showDropHint ? (
          <ThreadBoardDropHint key="drop-hint" isSinglePane={props.isSinglePane} />
        ) : null}
      </AnimatePresence>
    </>
  );
});

const ThreadBoardPane = memo(function ThreadBoardPane(props: {
  deferContent: boolean;
  dropPreviewDirection?: ThreadBoardDropDirection | null;
  isFocusedPane: boolean;
  isSinglePane: boolean;
  pane: ChatThreadBoardPaneState;
  shortcutsEnabled: boolean;
  showDropHint?: boolean;
  showSidebarTrigger: boolean;
  splitPane?: boolean;
  visibleBoardThreadIds?: ReadonlyArray<ThreadId>;
  onClosePane: (pane: ChatThreadBoardPaneState) => void;
  onPaneDragEnter?: ThreadBoardPaneDragHandler;
  onPaneDragLeave?: ThreadBoardPaneDragLeaveHandler;
  onPaneDragOver?: ThreadBoardPaneDragHandler;
  onPaneDrop?: ThreadBoardPaneDragHandler;
  onPaneDragEnd?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onPaneDragStart?: ThreadBoardPaneDragStartHandler;
  setActivePane: (paneId: string) => void;
}) {
  const { pane } = props;
  const visibleBoardThreadIds = props.visibleBoardThreadIds ?? EMPTY_VISIBLE_BOARD_THREAD_IDS;
  const isFocusedPane = props.isSinglePane || props.isFocusedPane;
  const isDimmedPane = !props.isSinglePane && !isFocusedPane;

  return (
    <div
      className={cn(
        "group/thread-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
      )}
      onDragEnter={
        props.onPaneDragEnter
          ? (event) => {
              props.onPaneDragEnter?.(pane, event);
            }
          : undefined
      }
      onDragLeave={
        props.onPaneDragLeave
          ? (event) => {
              props.onPaneDragLeave?.(pane.id, event);
            }
          : undefined
      }
      onDragOver={
        props.onPaneDragOver
          ? (event) => {
              props.onPaneDragOver?.(pane, event);
            }
          : undefined
      }
      onDrop={
        props.onPaneDrop
          ? (event) => {
              props.onPaneDrop?.(pane, event);
            }
          : undefined
      }
      onPointerDown={() => {
        if (!isFocusedPane) {
          props.setActivePane(pane.id);
        }
      }}
      onFocusCapture={() => {
        if (!isFocusedPane) {
          props.setActivePane(pane.id);
        }
      }}
    >
      <ThreadBoardPaneContent
        deferContent={props.deferContent}
        isDimmedPane={isDimmedPane}
        isFocusedPane={isFocusedPane}
        isSinglePane={props.isSinglePane}
        pane={pane}
        shortcutsEnabled={props.shortcutsEnabled}
        showSidebarTrigger={props.showSidebarTrigger}
        splitPane={props.splitPane}
        visibleBoardThreadIds={visibleBoardThreadIds}
        onClosePane={props.onClosePane}
        onPaneDragEnd={props.onPaneDragEnd}
        onPaneDragStart={props.onPaneDragStart}
      />

      <ThreadBoardPaneDropLayer
        dropPreviewDirection={props.dropPreviewDirection}
        isSinglePane={props.isSinglePane}
        pane={pane}
        showDropHint={props.showDropHint}
        onPaneDragEnter={props.onPaneDragEnter}
        onPaneDragLeave={props.onPaneDragLeave}
        onPaneDragOver={props.onPaneDragOver}
        onPaneDrop={props.onPaneDrop}
      />

      {!props.isSinglePane ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[33] border transition-[border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            "duration-300",
            isFocusedPane
              ? "border-primary/36 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.05)]"
              : "border-border/35",
          )}
        />
      ) : null}
    </div>
  );
});

export function ThreadBoard(props: { connectionUrl?: string | null; threadId: ThreadId }) {
  const navigate = useNavigate();
  const branchRefs = useRef(new Map<string, HTMLDivElement>());
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
  const activeRouteThread = useMemo(
    () => ({
      connectionUrl: props.connectionUrl ?? null,
      threadId: props.threadId,
      title: routeSidebarThread?.title ?? null,
    }),
    [props.connectionUrl, props.threadId, routeSidebarThread?.title],
  );
  const orderedPanes = useMemo(() => orderBoardPanes(panes, layoutRoot), [layoutRoot, panes]);
  const visibleBoardThreadIds = useMemo<ThreadId[]>(
    () => orderedPanes.map((pane) => pane.threadId),
    [orderedPanes],
  );
  const primaryPane = useMemo(
    () => selectBoardPaneById(panes, activePaneId) ?? orderedPanes[0],
    [activePaneId, orderedPanes, panes],
  );
  const paneById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes]);
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
  const paneDropRectCacheRef = useRef(new Map<string, DOMRect>());
  const [deferredPaneContentIds, setDeferredPaneContentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const deferredPaneContentFrameIdsRef = useRef<number[]>([]);

  const clearDeferredPaneContentFrames = useCallback(() => {
    for (const frameId of deferredPaneContentFrameIdsRef.current) {
      window.cancelAnimationFrame(frameId);
    }
    deferredPaneContentFrameIdsRef.current = [];
  }, []);

  const deferPaneContentMount = useCallback(
    (paneIds: ReadonlyArray<string | null | undefined>) => {
      const ids = paneIds.filter((paneId): paneId is string => Boolean(paneId));
      if (ids.length === 0) {
        return;
      }
      clearDeferredPaneContentFrames();
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
    },
    [clearDeferredPaneContentFrames],
  );

  useEffect(
    () => () => {
      clearDeferredPaneContentFrames();
    },
    [clearDeferredPaneContentFrames],
  );

  const navigateToSingleThreadRoute = useCallback(
    (pane: { connectionUrl: string | null; threadId: ThreadId }) => {
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: pane.threadId },
          replace: true,
          search: buildSingleThreadRouteSearch({ connectionUrl: pane.connectionUrl }),
        });
      });
    },
    [navigate],
  );

  const buildBoardTitle = useCallback(
    (threads: ReadonlyArray<{ threadId: ThreadId; title?: string | null | undefined }>) =>
      buildThreadBoardTitle({
        fallbackIndex: savedSplitCount + 1,
        threads: threads.map((thread) => ({
          threadId: thread.threadId,
          title:
            thread.title ?? useStore.getState().sidebarThreadsById[thread.threadId]?.title ?? null,
        })),
      }),
    [savedSplitCount],
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
      if (nextPanes.length <= 1) {
        navigateToSingleThreadRoute(nextActivePane);
      }
    },
    [closePane, navigateToSingleThreadRoute, panes, primaryPane],
  );

  const clearDropTarget = useCallback(() => {
    paneDropRectCacheRef.current.clear();
    if (dropTargetRef.current === null) {
      return;
    }
    dropTargetRef.current = null;
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

  const handleBoardDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!isThreadBoardDrag(event.dataTransfer)) {
        return;
      }
      const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      clearDropTarget();
    },
    [clearDropTarget],
  );

  const handleBoardDropCapture = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!isThreadBoardDrag(event.dataTransfer)) {
        return;
      }
      clearDropTarget();
    },
    [clearDropTarget],
  );

  const handlePaneDragLeave = useCallback(
    (paneId: string, event: ReactDragEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      if (dropTargetRef.current?.paneId !== paneId) {
        return;
      }
      dropTargetRef.current = null;
      setDropTarget(null);
    },
    [],
  );

  const updatePaneDropTarget = useCallback(
    (pane: ChatThreadBoardPaneState, event: ReactDragEvent<HTMLDivElement>) => {
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
    },
    [],
  );

  const handlePaneDragEnter = useCallback(
    (pane: ChatThreadBoardPaneState, event: ReactDragEvent<HTMLDivElement>) => {
      updatePaneDropTarget(pane, event);
    },
    [updatePaneDropTarget],
  );

  const handlePaneDragOver = useCallback(
    (pane: ChatThreadBoardPaneState, event: ReactDragEvent<HTMLDivElement>) => {
      updatePaneDropTarget(pane, event);
    },
    [updatePaneDropTarget],
  );

  const handlePaneDrop = useCallback(
    (pane: ChatThreadBoardPaneState, event: ReactDragEvent<HTMLDivElement>) => {
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
    },
    [
      activeRouteThread,
      boardVisible,
      buildBoardTitle,
      clearDropTarget,
      deferPaneContentMount,
      movePane,
      openThreadInBoard,
      syncRouteThread,
    ],
  );

  const handlePaneDragStart = useCallback(
    (pane: ChatThreadBoardPaneState, label: string, event: ReactDragEvent<HTMLButtonElement>) => {
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
    },
    [setActivePane],
  );

  const handlePaneDragEnd = useCallback(() => {
    setActiveThreadBoardDrag(null);
    clearDropTarget();
  }, [clearDropTarget]);

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

  const applyBranchResizePreview = useCallback(
    (children: readonly HTMLElement[], ratios: readonly number[]) => {
      for (const [index, child] of children.entries()) {
        child.style.flexGrow = String(ratios[index] ?? 1);
      }
    },
    [],
  );

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
        document.body.style.cursor = axis === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      },
    [layoutRoot],
  );

  const handleBranchResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [applyBranchResizePreview],
  );

  const handleBranchResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    },
    [applyBranchResizePreview, setBranchRatios],
  );

  useEffect(() => {
    const clear = () => {
      clearDropTarget();
      setActiveThreadBoardDrag(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [clearDropTarget]);

  useEffect(() => {
    const resetResizeInteractions = () => {
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
  }, [applyBranchResizePreview, setBranchRatios]);

  const renderLeaf = useCallback(
    (paneId: string) => {
      const pane = paneById.get(paneId);
      if (!pane || !primaryPane) {
        return null;
      }
      return (
        <ThreadBoardPane
          key={pane.id}
          deferContent={deferredPaneContentIds.has(pane.id)}
          dropPreviewDirection={dropTarget?.paneId === pane.id ? dropTarget.direction : null}
          isFocusedPane={(activePaneId ?? primaryPane.id) === pane.id}
          isSinglePane={false}
          pane={pane}
          shortcutsEnabled={(activePaneId ?? primaryPane.id) === pane.id}
          showSidebarTrigger={pane.id === firstPaneId}
          visibleBoardThreadIds={visibleBoardThreadIds}
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
    },
    [
      activePaneId,
      deferredPaneContentIds,
      dropTarget,
      firstPaneId,
      handleClosePane,
      handlePaneDragEnter,
      handlePaneDragLeave,
      handlePaneDragOver,
      handlePaneDrop,
      handlePaneDragEnd,
      handlePaneDragStart,
      paneById,
      primaryPane,
      setActivePane,
      visibleBoardThreadIds,
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
                data-thread-board-branch-child="true"
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
                    "group relative z-10 shrink-0 touch-none select-none outline-none transition-[background-color] duration-150",
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
                      "absolute rounded-full bg-primary/0 transition-[background-color,transform,opacity] duration-150 ease-out group-hover:bg-primary/10 group-focus-visible:bg-primary/10 group-active:bg-primary/15",
                      node.axis === "horizontal"
                        ? "inset-y-2 left-1/2 w-1 -translate-x-1/2 group-hover:scale-x-125"
                        : "inset-x-2 top-1/2 h-1 -translate-y-1/2 group-hover:scale-y-125",
                    )}
                  />
                  <div
                    className={cn(
                      "absolute bg-border/55 transition-colors duration-150 group-hover:bg-primary/45 group-focus-visible:bg-primary/45 group-active:bg-primary/60",
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
      title: activeRouteThread.title ?? "Untitled thread",
    };
    return (
      <div
        className={boardRootClassName}
        onDragEnter={handleBoardDragEnter}
        onDragLeave={handleBoardDragLeave}
        onDragOverCapture={handleBoardDragOverCapture}
        onDropCapture={handleBoardDropCapture}
      >
        <ThreadBoardPane
          deferContent={false}
          dropPreviewDirection={dropTarget?.paneId === singlePane.id ? dropTarget.direction : null}
          isFocusedPane
          isSinglePane
          pane={singlePane}
          shortcutsEnabled
          showSidebarTrigger
          showDropHint={dropTarget?.paneId !== singlePane.id}
          splitPane={false}
          onClosePane={() => {}}
          onPaneDragEnter={handlePaneDragEnter}
          onPaneDragLeave={handlePaneDragLeave}
          onPaneDragOver={handlePaneDragOver}
          onPaneDrop={handlePaneDrop}
          setActivePane={() => {}}
        />
      </div>
    );
  }

  return (
    <div
      className={boardRootClassName}
      onDragEnter={handleBoardDragEnter}
      onDragLeave={handleBoardDragLeave}
      onDragOverCapture={handleBoardDragOverCapture}
      onDropCapture={handleBoardDropCapture}
    >
      {renderLayoutNode(layoutRoot)}
    </div>
  );
}
