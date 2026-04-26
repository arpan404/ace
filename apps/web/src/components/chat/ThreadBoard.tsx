import { type ThreadId } from "@ace/contracts";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

interface ThreadBoardLayoutOption {
  columns: number;
  label: string;
  rows: number;
  value: string;
}

function isSameRoutePane(left: ChatThreadBoardRoutePane, right: ChatThreadBoardRoutePane): boolean {
  return left.threadId === right.threadId && left.connectionUrl === right.connectionUrl;
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

function buildThreadBoardLayoutOptions(paneCount: number): ThreadBoardLayoutOption[] {
  if (paneCount <= 1) {
    return [];
  }

  const columns = new Set<number>();
  for (let columnCount = 1; columnCount <= Math.min(4, paneCount); columnCount += 1) {
    columns.add(columnCount);
  }
  columns.add(paneCount);

  return [...columns].map((columnCount) => {
    const rows = Math.ceil(paneCount / columnCount);
    return {
      columns: columnCount,
      label: `${columnCount} x ${rows}`,
      rows,
      value: String(columnCount),
    };
  });
}

function getCurrentLayoutColumns(rows: readonly { paneIds: readonly string[] }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.paneIds.length), 1);
}

function ThreadBoardPane(props: {
  activePaneId: string | null;
  shortcutsEnabled: boolean;
  isPrimary: boolean;
  pane: ChatThreadBoardPaneState;
  showSidebarTrigger: boolean;
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
        splitPane
      />

      {!props.isPrimary ? (
        <>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="absolute right-2 top-2 z-30 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-background hover:text-foreground group-hover/thread-pane:opacity-100 focus-visible:opacity-100"
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
  const setActivePane = useChatThreadBoardStore((state) => state.setActivePane);
  const setActiveSplit = useChatThreadBoardStore((state) => state.setActiveSplit);
  const setGridLayout = useChatThreadBoardStore((state) => state.setGridLayout);
  const setPaneRatios = useChatThreadBoardStore((state) => state.setPaneRatios);
  const setRowRatios = useChatThreadBoardStore((state) => state.setRowRatios);
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
    return <ChatView connectionUrl={props.connectionUrl ?? null} threadId={props.threadId} />;
  }

  return (
    <div
      ref={boardRef}
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div className="absolute right-3 bottom-3 z-40">
        <Menu>
          <MenuTrigger
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/90 px-2 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Change split layout"
          >
            <LayoutGridIcon className="size-3.5" />
            <span>{currentLayoutColumns} col</span>
          </MenuTrigger>
          <MenuPopup align="end" side="top" className="min-w-44">
            <MenuGroup>
              <MenuGroupLabel>Split layout</MenuGroupLabel>
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
                    isPrimary={isPrimary}
                    pane={pane}
                    shortcutsEnabled={(activePaneId ?? primaryPane.id) === pane.id}
                    showSidebarTrigger={showSidebarTrigger}
                    onClose={() => {
                      handleClosePane(pane);
                    }}
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
