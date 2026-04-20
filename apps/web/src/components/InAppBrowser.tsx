import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BugIcon,
  Columns2Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  PinIcon,
  PictureInPicture2Icon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useInAppBrowserState,
  type ActiveBrowserRuntimeState,
  type InAppBrowserController,
  type InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";
import { isContextMenuPointerDown } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import type { BrowserTabState } from "~/lib/browser/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { BrowserNewTabPanel, BrowserSuggestionList } from "./browser/BrowserChrome";
import { BrowserFavicon, BrowserTabWebview } from "./browser/BrowserWebviewSurface";
import { isBrowserInternalTabUrl, isBrowserNewTabUrl } from "~/lib/browser/session";
import type { BrowserDesignRequestSubmission } from "~/lib/browser/types";
import { toastManager } from "./ui/toast";

export type {
  ActiveBrowserRuntimeState,
  InAppBrowserController,
  InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";

const SortableBrowserTab = memo(function SortableBrowserTab(props: {
  active: boolean;
  icon: ReactNode;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onContextMenuRequest: (tabId: string, position: { x: number; y: number }) => void;
  onTabNodeChange?: (tabId: string, node: HTMLDivElement | null) => void;
  suppressClickAfterDragRef: MutableRefObject<boolean>;
  suppressClickForContextMenuRef: MutableRefObject<boolean>;
  tab: BrowserTabState;
}) {
  const {
    active,
    icon,
    onActivate,
    onClose,
    onContextMenuRequest,
    onTabNodeChange,
    suppressClickAfterDragRef,
    suppressClickForContextMenuRef,
    tab,
  } = props;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: tab.id });
  const setTabNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      onTabNodeChange?.(tab.id, node);
    },
    [onTabNodeChange, setNodeRef, tab.id],
  );

  return (
    <div
      ref={setTabNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group flex min-w-0 max-w-56 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors duration-150",
        active
          ? "border-border bg-background text-foreground"
          : "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        isDragging && "z-20 opacity-70",
        isOver && !isDragging && "ring-1 ring-primary/15",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left"
        onPointerDownCapture={(event) => {
          suppressClickForContextMenuRef.current = false;
          if (
            isContextMenuPointerDown({
              button: event.button,
              ctrlKey: event.ctrlKey,
              isMac: /mac/i.test(navigator.platform),
            })
          ) {
            suppressClickForContextMenuRef.current = true;
            event.stopPropagation();
          }
        }}
        onClick={() => {
          if (suppressClickAfterDragRef.current) {
            suppressClickAfterDragRef.current = false;
            return;
          }
          if (suppressClickForContextMenuRef.current) {
            suppressClickForContextMenuRef.current = false;
            return;
          }
          onActivate(tab.id);
        }}
        onAuxClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          if (event.button !== 1) {
            return;
          }
          event.preventDefault();
          onClose(tab.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          suppressClickForContextMenuRef.current = true;
          onContextMenuRequest(tab.id, { x: event.clientX, y: event.clientY });
        }}
        title={tab.title}
        {...attributes}
        {...listeners}
      >
        {icon}
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        className="rounded-md p-0.5 text-muted-foreground opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
        aria-label={`Close ${tab.title}`}
        onClick={() => {
          onClose(tab.id);
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
});

interface InAppBrowserProps {
  open: boolean;
  mode: InAppBrowserMode;
  scopeId?: string;
  onClose: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onSplit: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  backShortcutLabel?: string | null;
  devToolsShortcutLabel?: string | null;
  forwardShortcutLabel?: string | null;
  reloadShortcutLabel?: string | null;
  viewportRef?: RefObject<HTMLDivElement | null>;
  onQueueDesignRequest?: (submission: BrowserDesignRequestSubmission) => Promise<void>;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

const DESIGNER_PILL_WIDTH_PX = 116;
const DESIGNER_PILL_HEIGHT_PX = 186;
const DESIGNER_PILL_MARGIN_PX = 18;

function clampDesignerPillPosition(
  position: { x: number; y: number } | null | undefined,
  viewport: { width: number; height: number } | null,
): { x: number; y: number } {
  const maxX = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    (viewport?.width ?? 0) - DESIGNER_PILL_WIDTH_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const maxY = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    (viewport?.height ?? 0) - DESIGNER_PILL_HEIGHT_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const fallbackY = Math.max(DESIGNER_PILL_MARGIN_PX, maxY);
  return {
    x: Math.min(maxX, Math.max(DESIGNER_PILL_MARGIN_PX, position?.x ?? DESIGNER_PILL_MARGIN_PX)),
    y: Math.min(maxY, Math.max(DESIGNER_PILL_MARGIN_PX, position?.y ?? fallbackY)),
  };
}

export const InAppBrowser = memo(function InAppBrowser(props: InAppBrowserProps) {
  const {
    open,
    mode,
    scopeId,
    onClose,
    onMinimize,
    onRestore,
    onSplit,
    onControllerChange,
    onActiveRuntimeStateChange,
    backShortcutLabel,
    devToolsShortcutLabel,
    forwardShortcutLabel,
    reloadShortcutLabel,
    viewportRef,
    onQueueDesignRequest,
  } = props;
  const {
    activateTab,
    activeRuntime,
    activeTab,
    activeTabIsInternal,
    activeTabIsNewTab,
    activeTabIsPinned,
    addressBarSuggestions,
    addressInputRef,
    applySuggestion,
    browserResetKey,
    browserSearchEngine,
    browserSession,
    browserShellStyle,
    browserStatusLabel,
    closeTab,
    designerState,
    draftUrl,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
    handlePipDragPointerDown,
    handlePipDragPointerEnd,
    handlePipDragPointerMove,
    handlePipResizePointerDown,
    handlePipResizePointerEnd,
    handlePipResizePointerMove,
    handleTabSnapshotChange,
    handleWebviewContextMenuFallbackRequest,
    openActiveTabExternally,
    openNewTab,
    openPinnedPage,
    openTabContextMenu,
    openUrl,
    pinnedPages,
    reorderTabs,
    registerWebviewHandle,
    reload,
    selectDesignerTool,
    selectedSuggestionIndex,
    setDraftUrl,
    setDesignerModeActive,
    setDesignerPillPosition,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    showAddressBarSuggestions,
    toggleDevTools,
    togglePinnedActivePage,
  } = useInAppBrowserState({
    mode,
    open,
    ...(scopeId ? { scopeId } : {}),
    ...(onActiveRuntimeStateChange ? { onActiveRuntimeStateChange } : {}),
    ...(onControllerChange ? { onControllerChange } : {}),
    ...(viewportRef ? { viewportRef } : {}),
  });

  const activeTabFavicon = activeTab ? (
    <BrowserFavicon
      url={activeTab.url}
      title={activeTab.title}
      className="size-3.5"
      fallbackClassName="size-3.5 text-muted-foreground"
    />
  ) : null;
  const devToolsButtonClassName = cn(
    activeRuntime.devToolsOpen &&
      "border-amber-500/40 bg-amber-500/[0.08] text-amber-800 hover:bg-amber-500/[0.12] dark:text-amber-200",
  );
  const tabDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const suppressTabClickAfterDragRef = useRef(false);
  const suppressTabClickForContextMenuRef = useRef(false);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const tabNodeMapRef = useRef(new Map<string, HTMLDivElement>());
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const designerPillDragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [canScrollTabsLeft, setCanScrollTabsLeft] = useState(false);
  const [canScrollTabsRight, setCanScrollTabsRight] = useState(false);
  const handleTabDragStart = useCallback((_event: DragStartEvent) => {
    suppressTabClickAfterDragRef.current = true;
  }, []);
  const handleTabDragCancel = useCallback((_event: DragCancelEvent) => {}, []);
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      reorderTabs(String(active.id), String(over.id));
    },
    [reorderTabs],
  );
  const registerTabNode = useCallback((tabId: string, node: HTMLDivElement | null) => {
    if (node) {
      tabNodeMapRef.current.set(tabId, node);
      return;
    }
    tabNodeMapRef.current.delete(tabId);
  }, []);
  const syncTabStripOverflow = useCallback(() => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      setCanScrollTabsLeft(false);
      setCanScrollTabsRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, tabStrip.scrollWidth - tabStrip.clientWidth);
    setCanScrollTabsLeft(tabStrip.scrollLeft > 1);
    setCanScrollTabsRight(maxScrollLeft - tabStrip.scrollLeft > 1);
  }, []);
  const scrollTabsBy = useCallback((direction: -1 | 1) => {
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      return;
    }

    const delta = Math.max(tabStrip.clientWidth * 0.65, 180) * direction;
    tabStrip.scrollBy({ left: delta, behavior: "smooth" });
  }, []);

  useEffect(() => {
    syncTabStripOverflow();
    const tabStrip = tabStripRef.current;
    if (!tabStrip) {
      return;
    }

    const handleScroll = () => {
      syncTabStripOverflow();
    };
    tabStrip.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncTabStripOverflow();
          })
        : null;
    resizeObserver?.observe(tabStrip);

    return () => {
      tabStrip.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
    };
  }, [syncTabStripOverflow]);

  useEffect(() => {
    syncTabStripOverflow();
  }, [browserSession.tabs, syncTabStripOverflow]);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    tabNodeMapRef.current.get(activeTab.id)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });

    const animationFrame = window.requestAnimationFrame(() => {
      syncTabStripOverflow();
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [activeTab, syncTabStripOverflow]);

  useEffect(() => {
    if (!open) {
      setDesignerModeActive(false);
    }
  }, [open, setDesignerModeActive]);

  useEffect(() => {
    if (activeTabIsInternal && designerState.active) {
      setDesignerModeActive(false);
    }
  }, [activeTabIsInternal, designerState.active, setDesignerModeActive]);
  const designerModeAvailable = Boolean(onQueueDesignRequest) && !activeTabIsInternal;
  const designerShortcutLabel =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘⇧E" : "Ctrl+Shift+E";
  const toggleDesignerMode = useCallback(() => {
    if (!designerModeAvailable) {
      return;
    }
    setDesignerModeActive(!designerState.active);
  }, [designerModeAvailable, designerState.active, setDesignerModeActive]);
  const designerPillPosition = useMemo(() => {
    const viewport = browserViewportRef.current;
    return clampDesignerPillPosition(
      designerState.pillPosition,
      viewport ? { height: viewport.clientHeight, width: viewport.clientWidth } : null,
    );
  }, [designerState.pillPosition]);
  const designerToolSummary =
    designerState.tool === "element-comment" ? "Element comment" : "Area comment";
  const handleDesignerPillPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("button, [data-designer-pill-control]")) {
        return;
      }
      event.preventDefault();
      const currentPosition = designerPillPosition;
      designerPillDragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: currentPosition.x,
        originY: currentPosition.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [designerPillPosition],
  );
  const handleDesignerPillPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = designerPillDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const viewport = browserViewportRef.current;
      setDesignerPillPosition(
        clampDesignerPillPosition(
          {
            x: dragState.originX + (event.clientX - dragState.startX),
            y: dragState.originY + (event.clientY - dragState.startY),
          },
          viewport ? { height: viewport.clientHeight, width: viewport.clientWidth } : null,
        ),
      );
    },
    [setDesignerPillPosition],
  );
  const handleDesignerPillPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = designerPillDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    designerPillDragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  useEffect(() => {
    if (!designerState.active) {
      return;
    }
    const viewport = browserViewportRef.current;
    const clampedPosition = clampDesignerPillPosition(
      designerState.pillPosition,
      viewport ? { height: viewport.clientHeight, width: viewport.clientWidth } : null,
    );
    if (
      clampedPosition.x === designerState.pillPosition?.x &&
      clampedPosition.y === designerState.pillPosition?.y
    ) {
      return;
    }
    setDesignerPillPosition(clampedPosition);
  }, [designerState.active, designerState.pillPosition, setDesignerPillPosition]);
  const handleBrowserSectionKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
      const usesMod = isMac ? event.metaKey : event.ctrlKey;
      if (
        usesMod &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "e" &&
        !isEditableKeyboardTarget(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggleDesignerMode();
        return;
      }
      handleBrowserKeyDownCapture(event);
    },
    [handleBrowserKeyDownCapture, toggleDesignerMode],
  );

  const queueDesignRequest = useCallback(
    async (submission: Omit<BrowserDesignRequestSubmission, "pagePath" | "pageUrl">) => {
      if (!activeTab || activeTabIsInternal || !onQueueDesignRequest) {
        throw new Error("Design request queue is unavailable for this tab.");
      }
      let pagePath = "/";
      try {
        const parsedUrl = new URL(activeTab.url);
        pagePath = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}` || "/";
      } catch {
        pagePath = "/";
      }
      await onQueueDesignRequest({
        ...submission,
        pageUrl: activeTab.url,
        pagePath,
      });
      setDesignerModeActive(false);
    },
    [activeTab, activeTabIsInternal, onQueueDesignRequest, setDesignerModeActive],
  );

  if (!open) {
    return null;
  }

  return (
    <div
      aria-hidden={!open}
      className={cn(
        mode === "split"
          ? "relative flex h-full min-h-0 min-w-0"
          : "absolute z-30 min-h-0 min-w-0 will-change-[left,top,width,height,transform] transition-[left,top,width,height,transform,opacity,border-radius] duration-250 ease-out",
        mode === "full" ? "inset-0" : mode === "pip" ? "pointer-events-auto" : null,
      )}
      style={browserShellStyle}
    >
      <section
        onKeyDownCapture={handleBrowserSectionKeyDownCapture}
        className={cn(
          "flex size-full min-h-0 flex-col overflow-hidden border border-border bg-background text-foreground [-webkit-app-region:no-drag]",
          mode === "full"
            ? "rounded-none shadow-none"
            : mode === "split"
              ? "rounded-none border-y-0 border-r-0 border-l-0 shadow-none"
              : "rounded-2xl shadow-none",
        )}
      >
        {mode === "pip" ? (
          <>
            <div
              className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 select-none"
              onDoubleClick={onRestore}
              onPointerDown={handlePipDragPointerDown}
              onPointerMove={handlePipDragPointerMove}
              onPointerUp={handlePipDragPointerEnd}
              onPointerCancel={handlePipDragPointerEnd}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                {activeTabFavicon}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {activeTab?.title ?? "Browser"}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {activeTab?.url ?? draftUrl}
                  </div>
                </div>
                {designerState.active ? (
                  <span className="rounded-full border border-primary/35 bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary/75">
                    Designer mode
                  </span>
                ) : null}
                {browserSession.tabs.length > 1 ? (
                  <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {browserSession.tabs.length} tabs
                  </span>
                ) : null}
                {activeRuntime.devToolsOpen ? (
                  <span className="rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                    DevTools
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5" data-browser-control>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "rounded-md transition-all duration-150",
                    designerState.active &&
                      "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
                  )}
                  onClick={toggleDesignerMode}
                  disabled={!designerModeAvailable}
                  aria-label={
                    designerState.active ? "Turn designer mode off" : "Turn designer mode on"
                  }
                  title={`Toggle designer mode (${designerShortcutLabel})`}
                  data-browser-control
                >
                  <SparklesIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "rounded-lg transition-all duration-150",
                    activeRuntime.devToolsOpen &&
                      "bg-amber-500/[0.08] text-amber-800 hover:bg-amber-500/[0.12] dark:text-amber-200",
                  )}
                  onClick={toggleDevTools}
                  disabled={activeTabIsInternal}
                  aria-label={
                    activeRuntime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools"
                  }
                  data-browser-control
                >
                  <BugIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={goBack}
                  disabled={activeTabIsInternal || !activeRuntime.canGoBack}
                  aria-label="Go back"
                  data-browser-control
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={goForward}
                  disabled={activeTabIsInternal || !activeRuntime.canGoForward}
                  aria-label="Go forward"
                  data-browser-control
                >
                  <ArrowRightIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={reload}
                  disabled={activeTabIsInternal}
                  aria-label={activeRuntime.loading ? "Stop loading" : "Reload page"}
                  data-browser-control
                >
                  {activeRuntime.loading ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={onRestore}
                  aria-label="Restore browser"
                  data-browser-control
                >
                  <Maximize2Icon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={() => {
                    openActiveTabExternally();
                  }}
                  aria-label="Open current page externally"
                  disabled={!activeTab || activeTabIsInternal}
                  data-browser-control
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-md transition-all duration-150"
                  onClick={onClose}
                  aria-label="Close browser"
                  data-browser-control
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 sm:px-5">
              <div className="relative flex min-w-0 flex-1 items-center">
                {canScrollTabsLeft ? (
                  <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-linear-to-r from-card to-transparent" />
                ) : null}
                {canScrollTabsRight ? (
                  <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-linear-to-l from-card to-transparent" />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "pointer-events-auto absolute top-1/2 left-0 z-20 -translate-y-1/2 rounded-full border border-border bg-background transition-opacity",
                    canScrollTabsLeft ? "opacity-100" : "pointer-events-none opacity-0",
                  )}
                  onClick={() => scrollTabsBy(-1)}
                  aria-label="Scroll tabs left"
                >
                  <ArrowLeftIcon className="size-3.5" />
                </Button>
                <DndContext
                  sensors={tabDnDSensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleTabDragStart}
                  onDragEnd={handleTabDragEnd}
                  onDragCancel={handleTabDragCancel}
                >
                  <SortableContext
                    items={browserSession.tabs.map((tab) => tab.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <div
                      ref={tabStripRef}
                      className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-8 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      data-testid="browser-tab-strip"
                    >
                      {browserSession.tabs.map((tab) => {
                        const isActive = activeTab?.id === tab.id;
                        const icon = isBrowserNewTabUrl(tab.url) ? (
                          <PlusIcon className="size-3 text-muted-foreground" />
                        ) : (
                          <BrowserFavicon
                            url={tab.url}
                            title={tab.title}
                            className="size-3"
                            fallbackClassName="size-3 text-muted-foreground"
                          />
                        );

                        return (
                          <SortableBrowserTab
                            key={tab.id}
                            active={isActive}
                            icon={icon}
                            onActivate={activateTab}
                            onClose={closeTab}
                            onContextMenuRequest={(tabId, position) => {
                              void openTabContextMenu(tabId, position);
                            }}
                            onTabNodeChange={registerTabNode}
                            suppressClickAfterDragRef={suppressTabClickAfterDragRef}
                            suppressClickForContextMenuRef={suppressTabClickForContextMenuRef}
                            tab={tab}
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "pointer-events-auto absolute top-1/2 right-0 z-20 -translate-y-1/2 rounded-full border border-border bg-background transition-opacity",
                    canScrollTabsRight ? "opacity-100" : "pointer-events-none opacity-0",
                  )}
                  onClick={() => scrollTabsBy(1)}
                  aria-label="Scroll tabs right"
                >
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      onClick={openNewTab}
                      aria-label="Open a new browser tab"
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">New tab</TooltipPopup>
              </Tooltip>
            </div>

            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 sm:px-5">
              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className={cn(
                          designerState.active &&
                            "border-primary/45 bg-primary/10 text-primary hover:bg-primary/14",
                        )}
                        onClick={toggleDesignerMode}
                        disabled={!designerModeAvailable}
                        aria-label={
                          designerState.active ? "Turn designer mode off" : "Turn designer mode on"
                        }
                      >
                        <SparklesIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {designerState.active
                      ? `Turn designer mode off (${designerShortcutLabel})`
                      : designerModeAvailable
                        ? `Open designer mode (${designerShortcutLabel})`
                        : "Designer mode is unavailable for this tab"}
                  </TooltipPopup>
                </Tooltip>
                {designerState.active ? (
                  <span className="hidden items-center rounded-full border border-primary/25 bg-primary/6 px-2 py-0.5 text-[10px] font-medium text-primary/75 xl:inline-flex">
                    {designerToolSummary}
                  </span>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className={devToolsButtonClassName}
                        onClick={toggleDevTools}
                        disabled={activeTabIsInternal}
                        aria-label={
                          activeRuntime.devToolsOpen
                            ? "Close Chrome DevTools"
                            : "Open Chrome DevTools"
                        }
                      >
                        <BugIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {devToolsShortcutLabel
                      ? `${activeRuntime.devToolsOpen ? "Close Chrome DevTools" : "Open Chrome DevTools"} (${devToolsShortcutLabel})`
                      : activeRuntime.devToolsOpen
                        ? "Close Chrome DevTools"
                        : "Open Chrome DevTools"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={goBack}
                        disabled={activeTabIsInternal || !activeRuntime.canGoBack}
                        aria-label="Go back"
                      >
                        <ArrowLeftIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {backShortcutLabel ? `Back (${backShortcutLabel})` : "Back"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={goForward}
                        disabled={activeTabIsInternal || !activeRuntime.canGoForward}
                        aria-label="Go forward"
                      >
                        <ArrowRightIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {forwardShortcutLabel ? `Forward (${forwardShortcutLabel})` : "Forward"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={reload}
                        disabled={activeTabIsInternal}
                        aria-label={activeRuntime.loading ? "Stop loading" : "Reload page"}
                      >
                        {activeRuntime.loading ? (
                          <LoaderCircleIcon className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3.5" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {reloadShortcutLabel
                      ? `${activeRuntime.loading ? "Stop or reload" : "Reload"} (${reloadShortcutLabel})`
                      : activeRuntime.loading
                        ? "Stop or reload"
                        : "Reload"}
                  </TooltipPopup>
                </Tooltip>
              </div>

              <form
                className="relative flex min-w-0 flex-1 items-center gap-2"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  openUrl(draftUrl);
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-2 transition-colors duration-150 focus-within:border-primary focus-within:bg-background">
                  {activeTabFavicon}
                  <Input
                    ref={addressInputRef}
                    className="min-w-0 w-full flex-1 border-0 bg-transparent text-sm shadow-none"
                    unstyled
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => {
                      window.setTimeout(() => {
                        setIsAddressBarFocused(false);
                      }, 100);
                    }}
                    onFocusCapture={() => {
                      setIsAddressBarFocused(true);
                    }}
                    onKeyDown={handleAddressBarKeyDown}
                    placeholder="Enter a URL or search the web"
                    aria-label="Browser address bar"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    title={draftUrl}
                  />
                </div>
                {showAddressBarSuggestions ? (
                  <BrowserSuggestionList
                    activeIndex={selectedSuggestionIndex}
                    onHighlight={setSelectedSuggestionIndex}
                    suggestions={addressBarSuggestions}
                    onSelect={applySuggestion}
                  />
                ) : null}
                {browserStatusLabel ? (
                  <span className="hidden shrink-0 rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-2 py-0.5 text-[11px] font-medium text-amber-800 sm:inline-flex dark:text-amber-200">
                    {browserStatusLabel}
                  </span>
                ) : null}
              </form>

              <div className="flex shrink-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={mode === "split" ? onRestore : onSplit}
                        aria-label={mode === "split" ? "Expand browser" : "Open split view"}
                      >
                        {mode === "split" ? (
                          <Maximize2Icon className="size-3.5" />
                        ) : (
                          <Columns2Icon className="size-3.5" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {mode === "split" ? "Expand to full browser" : "Open split view"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={togglePinnedActivePage}
                        disabled={activeTabIsInternal || !activeTab}
                        aria-label={activeTabIsPinned ? "Unpin current page" : "Pin current page"}
                        className={cn(
                          activeTabIsPinned &&
                            "border-sky-500/40 bg-sky-500/[0.08] text-sky-700 hover:bg-sky-500/[0.12] dark:text-sky-200",
                        )}
                      >
                        <PinIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    {activeTabIsPinned ? "Unpin current page" : "Pin current page"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={onMinimize}
                        aria-label="Minimize browser to picture-in-picture"
                      >
                        <PictureInPicture2Icon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Minimize to PiP</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={() => {
                          openActiveTabExternally();
                        }}
                        disabled={!activeTab || activeTabIsInternal}
                        aria-label="Open current page externally"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Open externally</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-xs"
                        onClick={onClose}
                        aria-label="Close in-app browser"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">Close browser</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          </>
        )}

        <div ref={browserViewportRef} className="relative min-h-0 flex-1 bg-background">
          {activeTabIsNewTab ? (
            <BrowserNewTabPanel
              browserSearchEngine={browserSearchEngine}
              pinnedPages={pinnedPages}
              onOpenPinnedPage={openPinnedPage}
              onSubmitQuery={openUrl}
            />
          ) : null}
          {browserSession.tabs
            .filter((tab) => !isBrowserInternalTabUrl(tab.url))
            .map((tab) => (
              <BrowserTabWebview
                key={`${browserResetKey}:${tab.id}`}
                active={!activeTabIsInternal && activeTab?.id === tab.id}
                designerModeActive={
                  designerState.active && !activeTabIsInternal && activeTab?.id === tab.id
                }
                designerTool={designerState.tool}
                onDesignCaptureCancel={() => {
                  setDesignerModeActive(false);
                }}
                onDesignCaptureError={(message) => {
                  setDesignerModeActive(false);
                  toastManager.add({
                    type: "error",
                    title: "Designer comment failed.",
                    description: message,
                  });
                }}
                {...(onQueueDesignRequest
                  ? {
                      onDesignCaptureSubmit: queueDesignRequest,
                    }
                  : {})}
                onContextMenuFallbackRequest={handleWebviewContextMenuFallbackRequest}
                tab={tab}
                onHandleChange={registerWebviewHandle}
                onSnapshotChange={handleTabSnapshotChange}
              />
            ))}
          {designerState.active && designerModeAvailable ? (
            <div
              className="absolute z-30 w-[116px] select-none"
              style={{
                left: `${designerPillPosition.x}px`,
                top: `${designerPillPosition.y}px`,
              }}
            >
              <div
                className="overflow-hidden rounded-[28px] border border-border/60 bg-background/92 shadow-[0_18px_60px_-24px_rgba(0,0,0,0.55)] backdrop-blur-xl"
                onPointerDown={handleDesignerPillPointerDown}
                onPointerMove={handleDesignerPillPointerMove}
                onPointerUp={handleDesignerPillPointerEnd}
                onPointerCancel={handleDesignerPillPointerEnd}
              >
                <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground/70 uppercase">
                      Designer
                    </div>
                    <div className="truncate text-[11px] text-foreground/78">
                      {designerToolSummary}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-full p-1 text-muted-foreground/65 transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      setDesignerModeActive(false);
                    }}
                    aria-label="Close designer mode"
                    data-designer-pill-control
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
                <div className="flex flex-col gap-2 p-2.5">
                  <button
                    type="button"
                    className={cn(
                      "rounded-[22px] border px-3 py-3 text-left transition-all",
                      designerState.tool === "area-comment"
                        ? "border-primary/45 bg-primary/10 text-primary"
                        : "border-border/60 bg-background/80 text-foreground/82 hover:border-border hover:bg-accent/45",
                    )}
                    onClick={() => {
                      selectDesignerTool("area-comment");
                    }}
                    data-designer-pill-control
                  >
                    <div className="text-[10px] font-semibold tracking-[0.16em] uppercase">
                      Area
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      Drag a region and leave a comment.
                    </div>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-[22px] border px-3 py-3 text-left transition-all",
                      designerState.tool === "element-comment"
                        ? "border-primary/45 bg-primary/10 text-primary"
                        : "border-border/60 bg-background/80 text-foreground/82 hover:border-border hover:bg-accent/45",
                    )}
                    onClick={() => {
                      selectDesignerTool("element-comment");
                    }}
                    data-designer-pill-control
                  >
                    <div className="text-[10px] font-semibold tracking-[0.16em] uppercase">
                      Element
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      Click any element and comment with markup.
                    </div>
                  </button>
                </div>
                <div className="border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground/70">
                  Drag this pill. Draw markup in the preview before queueing.
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {mode === "pip" ? (
          <div
            className="absolute right-0 bottom-0 z-10 h-5 w-5 cursor-se-resize rounded-tl-xl bg-border"
            onPointerDown={handlePipResizePointerDown}
            onPointerMove={handlePipResizePointerMove}
            onPointerUp={handlePipResizePointerEnd}
            onPointerCancel={handlePipResizePointerEnd}
            data-browser-control
            aria-hidden="true"
          />
        ) : null}
      </section>
    </div>
  );
});
