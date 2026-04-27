import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleDotIcon,
  CropIcon,
  ExternalLinkIcon,
  LockIcon,
  LockOpenIcon,
  LoaderCircleIcon,
  MousePointer2Icon,
  RefreshCwIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
import { useThreadJumpHintVisibility } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import type { BrowserSessionStorage } from "~/lib/browser/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { BrowserNewTabPanel, BrowserSuggestionList } from "./browser/BrowserChrome";
import { BrowserTabWebview } from "./browser/BrowserWebviewSurface";
import { isBrowserInternalTabUrl } from "~/lib/browser/session";
import type { BrowserDesignRequestSubmission } from "~/lib/browser/types";
import type { BrowserDesignerTool } from "~/lib/browser/designer";
import { toastManager } from "./ui/toast";

export type {
  ActiveBrowserRuntimeState,
  InAppBrowserController,
  InAppBrowserMode,
} from "~/hooks/useInAppBrowserState";

interface InAppBrowserProps {
  open: boolean;
  activeInstance?: boolean;
  connectionUrl?: string | null | undefined;
  mode: InAppBrowserMode;
  scopeId?: string;
  visible?: boolean;
  onClose: () => void;
  onBrowserSessionChange?: (session: BrowserSessionStorage) => void;
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

function resolveAddressFieldPresentation(currentUrl: string | null): {
  hostOnlyLabel: string;
  security: "secure" | "insecure" | "none";
  securityLabel: string | null;
} {
  if (!currentUrl || currentUrl.trim().length === 0) {
    return { hostOnlyLabel: "", security: "none", securityLabel: null };
  }
  try {
    const parsedUrl = new URL(currentUrl);
    const host = parsedUrl.host.replace(/^www\./i, "");
    if (parsedUrl.protocol === "https:") {
      return { hostOnlyLabel: host, security: "secure", securityLabel: "Secure connection" };
    }
    if (parsedUrl.protocol === "http:") {
      return { hostOnlyLabel: host, security: "insecure", securityLabel: "Not secure" };
    }
    return { hostOnlyLabel: host, security: "none", securityLabel: null };
  } catch {
    return { hostOnlyLabel: currentUrl, security: "none", securityLabel: null };
  }
}

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

export const InAppBrowser = memo(function InAppBrowser(props: InAppBrowserProps) {
  const {
    open,
    activeInstance = true,
    connectionUrl,
    mode,
    scopeId,
    visible = activeInstance,
    onClose,
    onBrowserSessionChange,
    onControllerChange,
    onActiveRuntimeStateChange,
    backShortcutLabel,
    designerCursorShortcutLabel,
    designerAreaCommentShortcutLabel,
    designerDrawCommentShortcutLabel,
    designerElementCommentShortcutLabel,
    forwardShortcutLabel,
    reloadShortcutLabel,
    onQueueDesignRequest,
  } = props;
  const {
    activeRuntime,
    activeTab,
    activeTabIsInternal,
    activeTabIsNewTab,
    addressBarSuggestions,
    addressInputRef,
    applySuggestion,
    browserResetKey,
    browserSearchEngine,
    browserSession,
    browserShellStyle,
    designerState,
    draftUrl,
    goBack,
    goForward,
    handleAddressBarKeyDown,
    handleBrowserKeyDownCapture,
    handleTabSnapshotChange,
    handleWebviewContextMenuFallbackRequest,
    openActiveTabExternally,
    openUrl,
    registerWebviewHandle,
    reload,
    selectDesignerTool,
    selectedSuggestionIndex,
    setDraftUrl,
    setDesignerModeActive,
    setIsAddressBarFocused,
    setSelectedSuggestionIndex,
    showAddressBarSuggestions,
    zoomIn,
    zoomOut,
    zoomReset,
  } = useInAppBrowserState({
    designerModeEnabled: Boolean(onQueueDesignRequest),
    mode,
    open,
    onClose,
    ...(scopeId ? { scopeId } : {}),
    ...(onActiveRuntimeStateChange ? { onActiveRuntimeStateChange } : {}),
    ...(onControllerChange ? { onControllerChange } : {}),
  });
  useEffect(() => {
    onBrowserSessionChange?.(browserSession);
  }, [browserSession, onBrowserSessionChange]);
  const browserShellRef = useRef<HTMLElement | null>(null);
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const designerToolListRef = useRef<HTMLDivElement | null>(null);
  const designerToolButtonRefs = useRef(new Map<BrowserDesignerTool, HTMLButtonElement>());
  const [addressFieldExpanded, setAddressFieldExpanded] = useState(false);
  const [designerToolHighlightFrame, setDesignerToolHighlightFrame] = useState<{
    height: number;
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const {
    showThreadJumpHints: showDesignerToolShortcutHints,
    updateThreadJumpHintsVisibility: updateDesignerToolShortcutHintsVisibility,
  } = useThreadJumpHintVisibility();
  const forceExpandedAddressField = activeTabIsInternal || activeTabIsNewTab;
  const addressPresentation = useMemo(
    () => resolveAddressFieldPresentation(activeTab?.url ?? draftUrl),
    [activeTab?.url, draftUrl],
  );
  const shouldShowExpandedAddressField = forceExpandedAddressField || addressFieldExpanded;
  const SecurityIcon =
    addressPresentation.security === "secure"
      ? LockIcon
      : addressPresentation.security === "insecure"
        ? LockOpenIcon
        : null;

  useEffect(() => {
    if (!open) {
      setDesignerModeActive(false);
      setAddressFieldExpanded(false);
    }
  }, [open, setDesignerModeActive]);
  useEffect(() => {
    setAddressFieldExpanded(false);
  }, [activeTab?.id]);

  useEffect(() => {
    if (!window.desktopBridge?.onMenuAction) {
      return;
    }
    return window.desktopBridge.onMenuAction((action) => {
      if (!open || !visible || !activeInstance) {
        return;
      }
      if (action !== "zoom-in" && action !== "zoom-out" && action !== "zoom-reset") {
        return;
      }
      const activeElement = document.activeElement;
      if (
        !(activeElement instanceof HTMLElement) ||
        !browserShellRef.current?.contains(activeElement)
      ) {
        return;
      }
      if (action === "zoom-in") {
        zoomIn();
        return;
      }
      if (action === "zoom-out") {
        zoomOut();
        return;
      }
      zoomReset();
    });
  }, [activeInstance, open, visible, zoomIn, zoomOut, zoomReset]);

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

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
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
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
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
  }, [designerState.active, designerState.tool]);
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
        ref={browserShellRef}
        data-in-app-browser-shell="true"
        onKeyDownCapture={handleBrowserSectionKeyDownCapture}
        className={cn(
          "flex size-full min-h-0 flex-col overflow-hidden border border-border bg-background text-foreground [-webkit-app-region:no-drag]",
          mode === "full"
            ? "rounded-none shadow-none"
            : "rounded-none border-y-0 border-r-0 border-l-0 shadow-none",
        )}
      >
        <>
          <div className="flex h-12 items-center gap-2.5 border-b border-border bg-card px-3 sm:px-4">
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-35"
                      onClick={goBack}
                      disabled={activeTabIsInternal || !activeRuntime.canGoBack}
                      aria-label="Go back"
                    >
                      <ArrowLeftIcon className="size-4" />
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
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-35"
                      onClick={goForward}
                      disabled={activeTabIsInternal || !activeRuntime.canGoForward}
                      aria-label="Go forward"
                    >
                      <ArrowRightIcon className="size-4" />
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
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-35"
                      onClick={reload}
                      disabled={activeTabIsInternal}
                      aria-label={activeRuntime.loading ? "Stop loading" : "Reload page"}
                    >
                      {activeRuntime.loading ? (
                        <LoaderCircleIcon className="size-4 animate-spin" />
                      ) : (
                        <RefreshCwIcon className="size-4" />
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
              className="relative mx-auto flex w-full min-w-[16rem] max-w-[56rem] flex-[1_1_42rem] items-center gap-2"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                openUrl(draftUrl);
              }}
            >
              <div
                className={cn(
                  "group/address flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 transition-colors duration-150",
                  shouldShowExpandedAddressField
                    ? "border border-border bg-background focus-within:border-primary focus-within:bg-background"
                    : "border border-transparent bg-transparent hover:border-border/70 hover:bg-background/55",
                )}
              >
                {SecurityIcon ? (
                  <SecurityIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={addressPresentation.securityLabel ?? undefined}
                  />
                ) : null}
                {shouldShowExpandedAddressField ? (
                  <Input
                    ref={addressInputRef}
                    className="min-w-0 w-full flex-1 border-0 bg-transparent text-sm font-medium text-foreground shadow-none placeholder:text-muted-foreground/70"
                    unstyled
                    value={draftUrl}
                    onChange={(event) => setDraftUrl(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => {
                      if (!forceExpandedAddressField) {
                        setAddressFieldExpanded(false);
                      }
                      window.setTimeout(() => {
                        setIsAddressBarFocused(false);
                      }, 100);
                    }}
                    onFocusCapture={() => {
                      if (!forceExpandedAddressField) {
                        setAddressFieldExpanded(true);
                      }
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
                ) : (
                  <button
                    type="button"
                    className="min-w-0 w-full flex-1 truncate text-left text-sm font-medium text-foreground"
                    onClick={() => {
                      setAddressFieldExpanded(true);
                      setIsAddressBarFocused(true);
                      window.requestAnimationFrame(() => {
                        addressInputRef.current?.focus();
                        addressInputRef.current?.select();
                      });
                    }}
                    aria-label="Expand address bar"
                    title={activeTab?.url ?? draftUrl}
                  >
                    {addressPresentation.hostOnlyLabel || "Enter a URL or search the web"}
                  </button>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        className={cn(
                          "size-6 shrink-0 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-35",
                          "pointer-events-none opacity-0 transition-opacity duration-150",
                          "group-hover/address:pointer-events-auto group-hover/address:opacity-100",
                          "group-focus-within/address:pointer-events-auto group-focus-within/address:opacity-100",
                          forceExpandedAddressField &&
                            "pointer-events-auto opacity-100 group-hover/address:opacity-100",
                        )}
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
            {designerModeAvailable ? (
              <div ref={designerToolListRef} className="relative flex shrink-0 items-center gap-1">
                <div
                  className="pointer-events-none absolute z-0 rounded-md bg-primary/14 transition-[top,left,width,height,opacity] duration-200 ease-out"
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
                            "relative z-10 inline-flex size-7 items-center justify-center rounded-md border transition-[border-color,color,background-color] duration-150",
                            designerState.tool === tool
                              ? "border-primary/40 text-primary"
                              : "border-border/60 bg-background/90 text-muted-foreground hover:border-border hover:bg-accent/40 hover:text-foreground",
                          )}
                          onPointerDown={(event) => {
                            handleDesignerToolPointerDown(event, tool);
                          }}
                          onKeyDown={(event) => {
                            handleDesignerToolKeyDown(event, tool);
                          }}
                          aria-label={label}
                        >
                          <Icon className="size-3.5" />
                          {showDesignerToolShortcutHints && designerShortcutLabelByTool[tool] ? (
                            <span
                              className="pointer-events-none absolute -top-1 -right-1 inline-flex min-w-3.5 items-center justify-center rounded-full border border-border/70 bg-background px-0.5 font-mono text-[8px] font-medium leading-none text-foreground shadow-sm"
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
                    <TooltipPopup side="bottom">
                      {designerShortcutLabelByTool[tool]
                        ? `${label} (${designerShortcutLabelByTool[tool]})`
                        : label}
                    </TooltipPopup>
                  </Tooltip>
                ))}
              </div>
            ) : null}
          </div>
        </>

        <div ref={browserViewportRef} className="relative min-h-0 flex-1 bg-background">
          {activeTabIsNewTab ? (
            <BrowserNewTabPanel browserSearchEngine={browserSearchEngine} onSubmitQuery={openUrl} />
          ) : null}
          {browserSession.tabs
            .filter((tab) => !isBrowserInternalTabUrl(tab.url))
            .map((tab) => (
              <BrowserTabWebview
                key={`${browserResetKey}:${tab.id}`}
                active={visible && !activeTabIsInternal && activeTab?.id === tab.id}
                connectionUrl={connectionUrl}
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
        </div>
      </section>
    </motion.div>
  );
});
