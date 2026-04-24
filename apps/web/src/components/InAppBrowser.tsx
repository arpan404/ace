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
  CircleDotIcon,
  Columns2Icon,
  CropIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MousePointer2Icon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, type MotionStyle } from "motion/react";
import {
  useInAppBrowserState,
  type ActiveBrowserRuntimeState,
  type InAppBrowserController,
  type InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";
import { isContextMenuPointerDown, useThreadJumpHintVisibility } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import type { BrowserTabState } from "~/lib/browser/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { BrowserNewTabPanel, BrowserSuggestionList } from "./browser/BrowserChrome";
import { BrowserFavicon, BrowserTabWebview } from "./browser/BrowserWebviewSurface";
import { isBrowserInternalTabUrl, isBrowserNewTabUrl } from "~/lib/browser/session";
import type { BrowserDesignRequestSubmission } from "~/lib/browser/types";
import type { BrowserDesignerTool } from "~/lib/browser/designer";
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
  onFocusAdjacentTab: (tabId: string, direction: -1 | 1) => void;
  onFocusBoundaryTab: (boundary: "first" | "last") => void;
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
    onFocusAdjacentTab,
    onFocusBoundaryTab,
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
        {...attributes}
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
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
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onFocusAdjacentTab(tab.id, -1);
            return;
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            onFocusAdjacentTab(tab.id, 1);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            onFocusBoundaryTab("first");
            return;
          }
          if (event.key === "End") {
            event.preventDefault();
            onFocusBoundaryTab("last");
            return;
          }
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenuRequest(tab.id, {
              x: Math.round(bounds.left + Math.min(bounds.width / 2, 24)),
              y: Math.round(bounds.bottom),
            });
          }
        }}
        title={tab.title}
        {...listeners}
      >
        {icon}
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        className="rounded-md p-0.5 text-muted-foreground opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
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
  activeInstance?: boolean;
  mode: InAppBrowserMode;
  scopeId?: string;
  visible?: boolean;
  onClose: () => void;
  onRestore: () => void;
  onSplit: () => void;
  onControllerChange?: (controller: InAppBrowserController | null) => void;
  onActiveRuntimeStateChange?: (state: ActiveBrowserRuntimeState) => void;
  backShortcutLabel?: string | null;
  designerCursorShortcutLabel?: string | null;
  designerAreaCommentShortcutLabel?: string | null;
  designerDrawCommentShortcutLabel?: string | null;
  designerElementCommentShortcutLabel?: string | null;
  devToolsShortcutLabel?: string | null;
  forwardShortcutLabel?: string | null;
  reloadShortcutLabel?: string | null;
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

function shouldShowDesignerShortcutHints(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
): boolean {
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  return isMac ? event.metaKey : event.ctrlKey;
}

function resolveDesignerShortcutHintLabel(shortcutLabel: string): string {
  if (shortcutLabel.includes("+")) {
    const parts = shortcutLabel.split("+");
    const keyPart = parts[parts.length - 1];
    return keyPart?.trim() || shortcutLabel;
  }
  const stripped = shortcutLabel.replace(/[⌘⌃⌥⇧]/g, "").trim();
  return stripped.length > 0 ? stripped : shortcutLabel;
}

const DESIGNER_PILL_WIDTH_PX = 60;
const DESIGNER_PILL_HEIGHT_PX = 238;
const DESIGNER_PILL_MARGIN_PX = 14;
const BROWSER_SHELL_TRANSITION = {
  duration: 0.18,
  ease: [0.16, 1, 0.3, 1],
} as const;

const DESIGNER_TOOL_BUTTONS: ReadonlyArray<{
  tool: BrowserDesignerTool;
  label: string;
  Icon: typeof MousePointer2Icon;
}> = [
  { tool: "cursor", label: "Normal cursor", Icon: MousePointer2Icon },
  { tool: "area-comment", label: "Area comment", Icon: CropIcon },
  { tool: "draw-comment", label: "Draw comment", Icon: SquarePenIcon },
  { tool: "element-comment", label: "Element comment", Icon: CircleDotIcon },
];

interface DesignerViewportSize {
  width: number;
  height: number;
}

function clampDesignerPillPosition(
  position: { x: number; y: number } | null | undefined,
  viewport: DesignerViewportSize | null,
): { x: number; y: number } {
  const maxX = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    (viewport?.width ?? 0) - DESIGNER_PILL_WIDTH_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const maxY = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    (viewport?.height ?? 0) - DESIGNER_PILL_HEIGHT_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const fallbackX = Math.max(DESIGNER_PILL_MARGIN_PX, maxX);
  const fallbackY = Math.max(DESIGNER_PILL_MARGIN_PX, maxY);
  return {
    x: Math.min(maxX, Math.max(DESIGNER_PILL_MARGIN_PX, position?.x ?? fallbackX)),
    y: Math.min(maxY, Math.max(DESIGNER_PILL_MARGIN_PX, position?.y ?? fallbackY)),
  };
}

function resolveAnchoredDesignerPillPosition(
  position: { x: number; y: number },
  previousViewport: DesignerViewportSize,
  nextViewport: DesignerViewportSize,
): { x: number; y: number } {
  const previousMaxX = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    previousViewport.width - DESIGNER_PILL_WIDTH_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const previousMaxY = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    previousViewport.height - DESIGNER_PILL_HEIGHT_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const nextMaxX = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    nextViewport.width - DESIGNER_PILL_WIDTH_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const nextMaxY = Math.max(
    DESIGNER_PILL_MARGIN_PX,
    nextViewport.height - DESIGNER_PILL_HEIGHT_PX - DESIGNER_PILL_MARGIN_PX,
  );
  const leftOffset = Math.max(0, position.x - DESIGNER_PILL_MARGIN_PX);
  const rightOffset = Math.max(0, previousMaxX - position.x);
  const topOffset = Math.max(0, position.y - DESIGNER_PILL_MARGIN_PX);
  const bottomOffset = Math.max(0, previousMaxY - position.y);

  return clampDesignerPillPosition(
    {
      x: rightOffset <= leftOffset ? nextMaxX - rightOffset : DESIGNER_PILL_MARGIN_PX + leftOffset,
      y: bottomOffset <= topOffset ? nextMaxY - bottomOffset : DESIGNER_PILL_MARGIN_PX + topOffset,
    },
    nextViewport,
  );
}

export const InAppBrowser = memo(function InAppBrowser(props: InAppBrowserProps) {
  const {
    open,
    activeInstance = true,
    mode,
    scopeId,
    visible = activeInstance,
    onClose,
    onRestore,
    onSplit,
    onControllerChange,
    onActiveRuntimeStateChange,
    backShortcutLabel,
    designerCursorShortcutLabel,
    designerAreaCommentShortcutLabel,
    designerDrawCommentShortcutLabel,
    designerElementCommentShortcutLabel,
    devToolsShortcutLabel,
    forwardShortcutLabel,
    reloadShortcutLabel,
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
    closeTab,
    designerState,
    draftUrl,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
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
    designerModeEnabled: Boolean(onQueueDesignRequest),
    mode,
    open: open && activeInstance,
    ...(scopeId ? { scopeId } : {}),
    ...(onActiveRuntimeStateChange ? { onActiveRuntimeStateChange } : {}),
    ...(onControllerChange ? { onControllerChange } : {}),
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
  const previousDesignerViewportSizeRef = useRef<DesignerViewportSize | null>(null);
  const designerToolListRef = useRef<HTMLDivElement | null>(null);
  const designerToolButtonRefs = useRef(new Map<BrowserDesignerTool, HTMLButtonElement>());
  const designerPillDragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [designerToolHighlightFrame, setDesignerToolHighlightFrame] = useState<{
    height: number;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [browserViewportSize, setBrowserViewportSize] = useState<DesignerViewportSize | null>(null);
  const {
    showThreadJumpHints: showDesignerToolShortcutHints,
    updateThreadJumpHintsVisibility: updateDesignerToolShortcutHintsVisibility,
  } = useThreadJumpHintVisibility();
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
  const focusTabById = useCallback(
    (tabId: string) => {
      const node = tabNodeMapRef.current.get(tabId);
      const button = node?.querySelector<HTMLButtonElement>('[role="tab"]');
      if (!button) {
        return;
      }
      button.focus();
      activateTab(tabId);
    },
    [activateTab],
  );
  const focusAdjacentTab = useCallback(
    (tabId: string, direction: -1 | 1) => {
      const currentIndex = browserSession.tabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex < 0 || browserSession.tabs.length === 0) {
        return;
      }
      const nextIndex =
        (currentIndex + direction + browserSession.tabs.length) % browserSession.tabs.length;
      const nextTabId = browserSession.tabs[nextIndex]?.id;
      if (nextTabId) {
        focusTabById(nextTabId);
      }
    },
    [browserSession.tabs, focusTabById],
  );
  const focusBoundaryTab = useCallback(
    (boundary: "first" | "last") => {
      const targetTab =
        boundary === "first"
          ? browserSession.tabs[0]
          : browserSession.tabs[browserSession.tabs.length - 1];
      if (targetTab) {
        focusTabById(targetTab.id);
      }
    },
    [browserSession.tabs, focusTabById],
  );
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
  const toggleDesignerMode = useCallback(() => {
    if (!designerModeAvailable) {
      return;
    }
    setDesignerModeActive(!designerState.active);
  }, [designerModeAvailable, designerState.active, setDesignerModeActive]);
  useEffect(() => {
    if (!visible || !designerModeAvailable) {
      updateDesignerToolShortcutHintsVisibility(false);
      return;
    }

    const onWindowKeyDown = (event: KeyboardEvent) => {
      updateDesignerToolShortcutHintsVisibility(shouldShowDesignerShortcutHints(event));
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      updateDesignerToolShortcutHintsVisibility(shouldShowDesignerShortcutHints(event));
    };
    const onWindowBlur = () => {
      updateDesignerToolShortcutHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [designerModeAvailable, updateDesignerToolShortcutHintsVisibility, visible]);
  useEffect(() => {
    const viewport = browserViewportRef.current;
    if (!viewport) {
      return;
    }
    const syncBrowserViewportSize = () => {
      const nextViewportSize = {
        width: Math.max(1, Math.round(viewport.clientWidth)),
        height: Math.max(1, Math.round(viewport.clientHeight)),
      };
      setBrowserViewportSize((current) => {
        if (
          current?.width === nextViewportSize.width &&
          current?.height === nextViewportSize.height
        ) {
          return current;
        }
        return nextViewportSize;
      });
    };
    syncBrowserViewportSize();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncBrowserViewportSize();
          })
        : null;
    observer?.observe(viewport);
    return () => {
      observer?.disconnect();
    };
  }, []);
  const designerViewport = useMemo<DesignerViewportSize | null>(() => {
    if (browserViewportSize) {
      return browserViewportSize;
    }
    const viewport = browserViewportRef.current;
    if (!viewport) {
      return null;
    }
    return {
      width: Math.max(1, viewport.clientWidth),
      height: Math.max(1, viewport.clientHeight),
    };
  }, [browserViewportSize]);
  const designerPillPosition = useMemo(() => {
    return clampDesignerPillPosition(designerState.pillPosition, designerViewport);
  }, [designerState.pillPosition, designerViewport]);
  const designerShortcutLabelByTool = useMemo<Record<BrowserDesignerTool, string | null>>(
    () => ({
      cursor: designerCursorShortcutLabel ?? null,
      "area-comment": designerAreaCommentShortcutLabel ?? null,
      "draw-comment": designerDrawCommentShortcutLabel ?? null,
      "element-comment": designerElementCommentShortcutLabel ?? null,
    }),
    [
      designerAreaCommentShortcutLabel,
      designerCursorShortcutLabel,
      designerDrawCommentShortcutLabel,
      designerElementCommentShortcutLabel,
    ],
  );
  const setDesignerToolButtonRef = useCallback(
    (tool: BrowserDesignerTool, node: HTMLButtonElement | null) => {
      const nodeMap = designerToolButtonRefs.current;
      if (node) {
        nodeMap.set(tool, node);
        return;
      }
      nodeMap.delete(tool);
    },
    [],
  );
  const handleDesignerToolPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, tool: BrowserDesignerTool) => {
      event.preventDefault();
      event.stopPropagation();
      selectDesignerTool(tool);
    },
    [selectDesignerTool],
  );
  const handleDesignerToolKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tool: BrowserDesignerTool) => {
      const toolIndex = DESIGNER_TOOL_BUTTONS.findIndex((item) => item.tool === tool);
      if (toolIndex < 0) {
        return;
      }
      const focusTool = (nextTool: BrowserDesignerTool) => {
        selectDesignerTool(nextTool);
        designerToolButtonRefs.current.get(nextTool)?.focus();
      };

      if (event.key === "ArrowUp") {
        event.preventDefault();
        const previous =
          DESIGNER_TOOL_BUTTONS[
            (toolIndex - 1 + DESIGNER_TOOL_BUTTONS.length) % DESIGNER_TOOL_BUTTONS.length
          ]?.tool;
        if (previous) {
          focusTool(previous);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = DESIGNER_TOOL_BUTTONS[(toolIndex + 1) % DESIGNER_TOOL_BUTTONS.length]?.tool;
        if (next) {
          focusTool(next);
        }
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const firstTool = DESIGNER_TOOL_BUTTONS[0]?.tool;
        if (firstTool) {
          focusTool(firstTool);
        }
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const lastTool = DESIGNER_TOOL_BUTTONS[DESIGNER_TOOL_BUTTONS.length - 1]?.tool;
        if (lastTool) {
          focusTool(lastTool);
        }
      }
    },
    [selectDesignerTool],
  );
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
      setDesignerPillPosition(
        clampDesignerPillPosition(
          {
            x: dragState.originX + (event.clientX - dragState.startX),
            y: dragState.originY + (event.clientY - dragState.startY),
          },
          designerViewport,
        ),
      );
    },
    [designerViewport, setDesignerPillPosition],
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
    if (!designerViewport || !designerState.pillPosition) {
      previousDesignerViewportSizeRef.current = designerViewport;
      return;
    }
    const previousViewport = previousDesignerViewportSizeRef.current;
    previousDesignerViewportSizeRef.current = designerViewport;
    const nextPosition =
      previousViewport &&
      (previousViewport.width !== designerViewport.width ||
        previousViewport.height !== designerViewport.height)
        ? resolveAnchoredDesignerPillPosition(
            designerState.pillPosition,
            previousViewport,
            designerViewport,
          )
        : clampDesignerPillPosition(designerState.pillPosition, designerViewport);
    if (
      nextPosition.x === designerState.pillPosition.x &&
      nextPosition.y === designerState.pillPosition.y
    ) {
      return;
    }
    setDesignerPillPosition(nextPosition);
  }, [designerState.pillPosition, designerViewport, setDesignerPillPosition]);
  useLayoutEffect(() => {
    const toolList = designerToolListRef.current;
    const activeButton = designerToolButtonRefs.current.get(designerState.tool);
    if (!designerState.active || !toolList || !activeButton) {
      setDesignerToolHighlightFrame(null);
      return;
    }
    const syncHighlightFrame = () => {
      const listRect = toolList.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      const nextFrame = {
        height: Math.round(buttonRect.height),
        left: Math.round(buttonRect.left - listRect.left),
        top: Math.round(buttonRect.top - listRect.top),
        width: Math.round(buttonRect.width),
      };
      setDesignerToolHighlightFrame((current) => {
        if (
          current?.height === nextFrame.height &&
          current.left === nextFrame.left &&
          current.top === nextFrame.top &&
          current.width === nextFrame.width
        ) {
          return current;
        }
        return nextFrame;
      });
    };
    syncHighlightFrame();
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncHighlightFrame();
          })
        : null;
    resizeObserver?.observe(toolList);
    resizeObserver?.observe(activeButton);
    window.addEventListener("resize", syncHighlightFrame);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncHighlightFrame);
    };
  }, [designerPillPosition.x, designerPillPosition.y, designerState.active, designerState.tool]);
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
    },
    [activeTab, activeTabIsInternal, onQueueDesignRequest],
  );

  if (!open) {
    return null;
  }

  return (
    <motion.div
      aria-hidden={!visible}
      initial={mode === "full" ? { opacity: 0, scale: 0.99 } : { opacity: 0, x: 16 }}
      animate={
        visible
          ? { opacity: 1, scale: 1, x: 0 }
          : mode === "full"
            ? { opacity: 0, scale: 0.99 }
            : { opacity: 0, x: 16 }
      }
      exit={mode === "full" ? { opacity: 0, scale: 0.99 } : { opacity: 0, x: 16 }}
      transition={BROWSER_SHELL_TRANSITION}
      className={cn(
        mode === "split"
          ? visible
            ? "relative flex h-full min-h-0 min-w-0"
            : "pointer-events-none invisible absolute inset-0 z-0 min-h-0 min-w-0"
          : cn(
              "absolute inset-0 min-h-0 min-w-0",
              visible ? "z-30" : "pointer-events-none invisible z-0",
            ),
      )}
      {...(browserShellStyle ? { style: browserShellStyle as MotionStyle } : {})}
    >
      <section
        onKeyDownCapture={handleBrowserSectionKeyDownCapture}
        className={cn(
          "flex size-full min-h-0 flex-col overflow-hidden border border-border bg-background text-foreground [-webkit-app-region:no-drag]",
          mode === "full"
            ? "rounded-none shadow-none"
            : "rounded-none border-y-0 border-r-0 border-l-0 shadow-none",
        )}
      >
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
                    role="tablist"
                    aria-label="Browser tabs"
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
                          onFocusAdjacentTab={focusAdjacentTab}
                          onFocusBoundaryTab={focusBoundaryTab}
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
                active={visible && !activeTabIsInternal && activeTab?.id === tab.id}
                designerModeActive={
                  visible &&
                  designerState.active &&
                  !activeTabIsInternal &&
                  activeTab?.id === tab.id
                }
                designerTool={designerState.tool}
                onBrowserLoadError={(message) => {
                  toastManager.add({
                    type: "error",
                    title: "Browser load failed.",
                    description: message,
                  });
                }}
                onDesignCaptureCancel={() => {
                  return;
                }}
                onDesignCaptureError={(message) => {
                  toastManager.add({
                    type: "error",
                    title: "Comment failed.",
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
          {designerModeAvailable ? (
            <div
              className="absolute z-30 select-none"
              style={{
                left: `${designerPillPosition.x}px`,
                top: `${designerPillPosition.y}px`,
              }}
            >
              <div
                className="flex w-[60px] flex-col items-center gap-1.5 rounded-2xl border border-border/60 bg-background/90 px-1.5 py-2 shadow-[0_24px_80px_-42px_rgba(0,0,0,0.72)] backdrop-blur-xl"
                onPointerDown={handleDesignerPillPointerDown}
                onPointerMove={handleDesignerPillPointerMove}
                onPointerUp={handleDesignerPillPointerEnd}
                onPointerCancel={handleDesignerPillPointerEnd}
              >
                <div className="h-1 w-4 rounded-full bg-border/70" />
                <div className="h-px w-5 rounded-full bg-border/60" />
                <div ref={designerToolListRef} className="relative flex flex-col gap-1.5">
                  <div
                    className="pointer-events-none absolute z-0 rounded-xl bg-primary/14 shadow-[0_14px_30px_-20px_rgba(91,106,255,0.9)] transition-[top,left,width,height,opacity] duration-200 ease-out"
                    style={
                      designerToolHighlightFrame
                        ? {
                            height: `${designerToolHighlightFrame.height}px`,
                            left: `${designerToolHighlightFrame.left}px`,
                            top: `${designerToolHighlightFrame.top}px`,
                            width: `${designerToolHighlightFrame.width}px`,
                          }
                        : { opacity: 0 }
                    }
                    data-designer-tool-highlight
                  />
                  {DESIGNER_TOOL_BUTTONS.map(({ Icon, label, tool }) => (
                    <Tooltip key={tool}>
                      <TooltipTrigger
                        render={
                          <button
                            ref={(node) => {
                              setDesignerToolButtonRef(tool, node);
                            }}
                            type="button"
                            className={cn(
                              "relative z-10 inline-flex size-10 items-center justify-center rounded-xl border transition-[border-color,color,transform] duration-200",
                              designerState.tool === tool
                                ? "border-primary/35 text-primary"
                                : "border-border/60 bg-background/85 text-muted-foreground hover:border-border hover:bg-accent/40 hover:text-foreground",
                            )}
                            onPointerDown={(event) => {
                              handleDesignerToolPointerDown(event, tool);
                            }}
                            onKeyDown={(event) => {
                              handleDesignerToolKeyDown(event, tool);
                            }}
                            aria-label={label}
                            data-designer-pill-control
                          >
                            <Icon className="size-4" />
                            {showDesignerToolShortcutHints && designerShortcutLabelByTool[tool] ? (
                              <span
                                className="pointer-events-none absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full border border-border/70 bg-background px-1 font-mono text-[9px] font-medium leading-none text-foreground shadow-sm"
                                title={designerShortcutLabelByTool[tool] ?? undefined}
                              >
                                {resolveDesignerShortcutHintLabel(
                                  designerShortcutLabelByTool[tool] ?? "",
                                )}
                              </span>
                            ) : null}
                          </button>
                        }
                      />
                      <TooltipPopup side="right">
                        {designerShortcutLabelByTool[tool]
                          ? `${label} (${designerShortcutLabelByTool[tool]})`
                          : label}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </motion.div>
  );
});
