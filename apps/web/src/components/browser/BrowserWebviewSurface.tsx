import { CheckIcon, GlobeIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn, randomUUID } from "~/lib/utils";
import type { BrowserDesignerTool } from "~/lib/browser/designer";
import { type BrowserTabState, resolveBrowserTabTitle } from "~/lib/browser/session";
import {
  type BrowserDesignCaptureResult,
  type BrowserDesignCaptureSubmission,
  type BrowserDesignElementDescriptor,
  type BrowserDesignSelectionRect,
  type BrowserTabHandle,
  type BrowserTabSnapshot,
  type BrowserWebview,
  IN_APP_BROWSER_PARTITION,
} from "~/lib/browser/types";
import { normalizeBrowserHttpUrl } from "~/lib/browser/url";
import { useEffectEvent } from "~/hooks/useEffectEvent";

function isAbortedWebviewLoad(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    ("code" in error && error.code === "ERR_ABORTED") || ("errno" in error && error.errno === -3)
  );
}

function loadWebviewUrl(webview: BrowserWebview, url: string): void {
  void webview.loadURL(url).catch((error: unknown) => {
    if (isAbortedWebviewLoad(error)) {
      return;
    }
    throw error;
  });
}

function resolveBrowserFaviconSources(url: string): string[] {
  try {
    const parsed = new URL(url);
    const domainUrl = encodeURIComponent(parsed.origin);
    return [
      `https://www.google.com/s2/favicons?domain_url=${domainUrl}&sz=64`,
      new URL("/favicon.ico", parsed.origin).toString(),
    ];
  } catch {
    return [];
  }
}

interface BrowserPageElementCapture {
  targetRect: BrowserDesignSelectionRect | null;
  target: BrowserDesignElementDescriptor | null;
  mainContainer: BrowserDesignElementDescriptor | null;
}

interface ActiveDragSelection {
  pointerId: number;
  startX: number;
  startY: number;
  hostWidth: number;
  hostHeight: number;
}

interface BrowserDesignCaptureDraft {
  capture: BrowserDesignCaptureResult;
  tool: BrowserDesignerTool;
  viewportWidth: number;
  viewportHeight: number;
}

const MIN_CAPTURE_SIZE_PX = 24;
const DESIGN_REQUEST_PANEL_WIDTH_PX = 272;
const DESIGN_REQUEST_PANEL_HEIGHT_PX = 166;

function clampPoint(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeSelectionRect(input: {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  hostWidth: number;
  hostHeight: number;
}): BrowserDesignSelectionRect {
  const clampedStartX = clampPoint(input.startX, 0, input.hostWidth);
  const clampedStartY = clampPoint(input.startY, 0, input.hostHeight);
  const clampedCurrentX = clampPoint(input.currentX, 0, input.hostWidth);
  const clampedCurrentY = clampPoint(input.currentY, 0, input.hostHeight);
  const left = Math.min(clampedStartX, clampedCurrentX);
  const top = Math.min(clampedStartY, clampedCurrentY);
  const right = Math.max(clampedStartX, clampedCurrentX);
  const bottom = Math.max(clampedStartY, clampedCurrentY);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

function isPointInsideSelectionRect(
  point: { x: number; y: number },
  selection: BrowserDesignSelectionRect,
): boolean {
  return (
    point.x >= selection.x &&
    point.y >= selection.y &&
    point.x <= selection.x + selection.width &&
    point.y <= selection.y + selection.height
  );
}

function resolveDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/i.exec(dataUrl);
  return match?.[1] ?? "image/png";
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0 || commaIndex === dataUrl.length - 1) {
    return 0;
  }
  const base64Payload = dataUrl.slice(commaIndex + 1).replace(/\s+/g, "");
  const padding = base64Payload.endsWith("==") ? 2 : base64Payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64Payload.length * 3) / 4) - padding);
}

function normalizeCapturedDescriptor(value: unknown): BrowserDesignElementDescriptor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const objectValue = value as Record<string, unknown>;
  const toNullableString = (key: keyof BrowserDesignElementDescriptor): string | null => {
    const entry = objectValue[key];
    if (typeof entry !== "string") {
      return null;
    }
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    tagName: toNullableString("tagName"),
    id: toNullableString("id"),
    className: toNullableString("className"),
    selector: toNullableString("selector"),
    textSnippet: toNullableString("textSnippet"),
    htmlSnippet: toNullableString("htmlSnippet"),
  };
}

function normalizeCapturedSelectionRect(value: unknown): BrowserDesignSelectionRect | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const objectValue = value as Record<string, unknown>;
  const x = Number(objectValue.x);
  const y = Number(objectValue.y);
  const width = Number(objectValue.width);
  const height = Number(objectValue.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: Math.round(Math.max(0, x)),
    y: Math.round(Math.max(0, y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function buildBrowserElementCaptureScript(point: { x: number; y: number }): string {
  const serializedPoint = JSON.stringify({
    x: Math.max(0, Math.floor(point.x)),
    y: Math.max(0, Math.floor(point.y)),
  });
  return `(() => {
  const point = ${serializedPoint};
  const toSnippet = (value, maxLength) => {
    if (typeof value !== "string") return null;
    const collapsed = value.replace(/\\s+/g, " ").trim();
    if (!collapsed) return null;
    return collapsed.length > maxLength ? collapsed.slice(0, maxLength - 1) + "…" : collapsed;
  };
  const escapeCss = (value) => {
    if (typeof value !== "string") return "";
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  };
  const selectorFromElement = (element) => {
    if (!(element instanceof Element)) return null;
    if (element.id) return "#" + escapeCss(element.id);
    const segments = [];
    let current = element;
    for (let depth = 0; depth < 4 && current && current instanceof Element; depth += 1) {
      let segment = current.tagName.toLowerCase();
      const classList = Array.from(current.classList).slice(0, 2);
      if (classList.length > 0) {
        segment += "." + classList.map(escapeCss).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName,
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current);
          if (index >= 0) {
            segment += ":nth-of-type(" + String(index + 1) + ")";
          }
        }
      }
      segments.unshift(segment);
      if (!parent || current.tagName.toLowerCase() === "body") break;
      current = parent;
    }
    return segments.join(" > ");
  };
  const describe = (element) => {
    if (!(element instanceof Element)) return null;
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      className: element.className ? String(element.className) : null,
      selector: selectorFromElement(element),
      textSnippet: toSnippet(element.textContent ?? "", 320),
      htmlSnippet: toSnippet(element.outerHTML ?? "", 1200),
    };
  };
  const toRect = (element) => {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const x = Math.max(0, Math.floor(point.x));
  const y = Math.max(0, Math.floor(point.y));
  const target = document.elementFromPoint(x, y);
  const mainContainer =
    target instanceof Element
      ? target.closest("main, [role='main'], article, section, [data-testid], [class*='container'], [class*='content']") ?? target.parentElement
      : null;
  return {
    targetRect: toRect(target),
    target: describe(target),
    mainContainer: describe(mainContainer),
  };
})();`;
}

function generateDesignRequestId(): string {
  return `DR-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function BrowserFavicon(props: {
  url: string;
  title: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const { className, fallbackClassName, title, url } = props;
  const sources = useMemo(() => resolveBrowserFaviconSources(url), [url]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sources]);

  const source = sources[sourceIndex];
  if (!source) {
    return (
      <GlobeIcon className={cn("shrink-0", fallbackClassName, className)} aria-hidden="true" />
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 rounded-sm object-cover", className)}
      src={source}
      title={title}
      onError={() => {
        setSourceIndex((current) => {
          const nextIndex = current + 1;
          return nextIndex < sources.length ? nextIndex : current;
        });
      }}
    />
  );
}

export function BrowserTabWebview(props: {
  active: boolean;
  designerModeActive?: boolean;
  designerTool?: BrowserDesignerTool;
  onDesignCaptureCancel?: () => void;
  onDesignCaptureError?: (message: string) => void;
  onDesignCaptureSubmit?: (submission: BrowserDesignCaptureSubmission) => Promise<void>;
  onContextMenuFallbackRequest: (
    tabId: string,
    position: { x: number; y: number },
    requestedAt: number,
  ) => void;
  tab: BrowserTabState;
  onHandleChange: (tabId: string, handle: BrowserTabHandle | null) => void;
  onSnapshotChange: (tabId: string, snapshot: BrowserTabSnapshot) => void;
}) {
  const {
    active,
    designerModeActive = false,
    designerTool = "area-comment",
    onDesignCaptureCancel,
    onDesignCaptureError,
    onDesignCaptureSubmit,
    onContextMenuFallbackRequest,
    tab,
    onHandleChange,
    onSnapshotChange,
  } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<BrowserWebview | null>(null);
  const readyRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragSelectionRef = useRef<ActiveDragSelection | null>(null);
  const elementHoverFrameRef = useRef<number | null>(null);
  const pendingElementHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const elementHoverRequestInFlightRef = useRef(false);
  const annotationPointerRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const requestedUrlRef = useRef(tab.url);
  const [selectionRect, setSelectionRect] = useState<BrowserDesignSelectionRect | null>(null);
  const [hoveredElementCapture, setHoveredElementCapture] =
    useState<BrowserPageElementCapture | null>(null);
  const [designDraft, setDesignDraft] = useState<BrowserDesignCaptureDraft | null>(null);
  const [designInstructions, setDesignInstructions] = useState("");
  const [hasAnnotationStrokes, setHasAnnotationStrokes] = useState(false);
  const [isSubmittingDesignRequest, setIsSubmittingDesignRequest] = useState(false);
  const emitTabSnapshotChange = useEffectEvent((snapshot: BrowserTabSnapshot) => {
    onSnapshotChange(tab.id, snapshot);
  });
  const requestContextMenuFallback = useEffectEvent(
    (position: { x: number; y: number }, requestedAt: number) => {
      onContextMenuFallbackRequest(tab.id, position, requestedAt);
    },
  );

  const resolveSnapshotUrl = useCallback((currentUrl: string) => {
    return normalizeBrowserHttpUrl(currentUrl) ?? requestedUrlRef.current;
  }, []);

  const emitSnapshot = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return;
    }
    const resolvedUrl = resolveSnapshotUrl(webview.getURL());
    emitTabSnapshotChange({
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      devToolsOpen: webview.isDevToolsOpened(),
      loading: webview.isLoading(),
      title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
      url: resolvedUrl,
    });
  }, [resolveSnapshotUrl]);

  const navigate = useCallback(
    (url: string) => {
      requestedUrlRef.current = url;
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      const currentUrl = normalizeBrowserHttpUrl(webview.getURL());
      if (currentUrl === normalizeBrowserHttpUrl(url)) {
        emitSnapshot();
        return;
      }

      loadWebviewUrl(webview, url);
    },
    [emitSnapshot],
  );

  const inspectBrowserPoint = useCallback(
    async (point: { x: number; y: number }): Promise<BrowserPageElementCapture | null> => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current || !webview.executeJavaScript) {
        return null;
      }
      const capture = await webview.executeJavaScript<BrowserPageElementCapture | null>(
        buildBrowserElementCaptureScript(point),
        true,
      );
      return capture
        ? {
            targetRect: normalizeCapturedSelectionRect(capture.targetRect),
            target: normalizeCapturedDescriptor(capture.target ?? null),
            mainContainer: normalizeCapturedDescriptor(capture.mainContainer ?? null),
          }
        : null;
    },
    [],
  );

  const captureDesignSelection = useCallback(
    async (
      selection: BrowserDesignSelectionRect,
      requestId: string,
      inspectedPoint?: BrowserPageElementCapture | null,
    ): Promise<BrowserDesignCaptureResult> => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        throw new Error("The browser tab is not ready yet.");
      }
      if (!webview.capturePage || !webview.executeJavaScript) {
        throw new Error("Design capture is unavailable for this browser tab.");
      }

      const capturedImage = await webview.capturePage(selection);
      const imageDataUrl = capturedImage.toDataURL();
      const centerPoint = {
        x: selection.x + Math.floor(selection.width / 2),
        y: selection.y + Math.floor(selection.height / 2),
      };
      const elementCapture = inspectedPoint ?? (await inspectBrowserPoint(centerPoint));

      return {
        requestId,
        selection,
        imageDataUrl,
        imageMimeType: resolveDataUrlMimeType(imageDataUrl),
        imageSizeBytes: estimateDataUrlBytes(imageDataUrl),
        targetElement: elementCapture?.target ?? null,
        mainContainer: elementCapture?.mainContainer ?? null,
      };
    },
    [inspectBrowserPoint],
  );

  useEffect(() => {
    const handle: BrowserTabHandle = {
      closeDevTools: () => {
        if (!readyRef.current || !webviewRef.current?.isDevToolsOpened()) return;
        webviewRef.current.closeDevTools();
      },
      goBack: () => {
        if (!readyRef.current || !webviewRef.current?.canGoBack()) return;
        webviewRef.current.goBack();
      },
      goForward: () => {
        if (!readyRef.current || !webviewRef.current?.canGoForward()) return;
        webviewRef.current.goForward();
      },
      isDevToolsOpen: () => {
        if (!readyRef.current || !webviewRef.current) return false;
        return webviewRef.current.isDevToolsOpened();
      },
      navigate,
      openDevTools: () => {
        if (!readyRef.current || !webviewRef.current || webviewRef.current.isDevToolsOpened()) {
          return;
        }
        webviewRef.current.openDevTools({ mode: "detach" });
      },
      reload: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.reload();
      },
      stop: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.stop();
      },
    };
    onHandleChange(tab.id, handle);
    return () => {
      onHandleChange(tab.id, null);
    };
  }, [navigate, onHandleChange, tab.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webviewRef.current) return;

    const webview = document.createElement("webview") as BrowserWebview;
    webview.className = "size-full bg-background";
    webview.setAttribute("partition", IN_APP_BROWSER_PARTITION);
    webview.setAttribute("src", requestedUrlRef.current);

    const handleDomReady = () => {
      readyRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (
        pendingUrl &&
        normalizeBrowserHttpUrl(pendingUrl) !== normalizeBrowserHttpUrl(webview.getURL())
      ) {
        loadWebviewUrl(webview, pendingUrl);
        return;
      }
      emitSnapshot();
    };
    const handleLoadStart = () => {
      emitTabSnapshotChange({
        canGoBack: readyRef.current ? webview.canGoBack() : false,
        canGoForward: readyRef.current ? webview.canGoForward() : false,
        devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
        loading: true,
        title: resolveBrowserTabTitle(requestedUrlRef.current),
        url: requestedUrlRef.current,
      });
    };
    const handleNavigation = () => {
      emitSnapshot();
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      if (detail.errorCode === -3) {
        return;
      }
      const resolvedUrl = resolveSnapshotUrl(webview.getURL());
      emitTabSnapshotChange({
        canGoBack: readyRef.current ? webview.canGoBack() : false,
        canGoForward: readyRef.current ? webview.canGoForward() : false,
        devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
        loading: false,
        title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
        url: resolvedUrl,
      });
    };
    const handleContextMenu = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      requestContextMenuFallback(
        { x: mouseEvent.clientX, y: mouseEvent.clientY },
        performance.now(),
      );
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleNavigation);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("devtools-closed", handleNavigation);
    webview.addEventListener("devtools-opened", handleNavigation);
    webview.addEventListener("page-title-updated", handleNavigation);
    webview.addEventListener("did-fail-load", handleFailLoad);
    webview.addEventListener("contextmenu", handleContextMenu);

    host.replaceChildren(webview);
    webviewRef.current = webview;

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleNavigation);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("devtools-closed", handleNavigation);
      webview.removeEventListener("devtools-opened", handleNavigation);
      webview.removeEventListener("page-title-updated", handleNavigation);
      webview.removeEventListener("did-fail-load", handleFailLoad);
      webview.removeEventListener("contextmenu", handleContextMenu);
      host.replaceChildren();
      webviewRef.current = null;
      readyRef.current = false;
    };
  }, [emitSnapshot, resolveSnapshotUrl]);

  useEffect(() => {
    navigate(tab.url);
  }, [navigate, tab.url]);

  const clearAnnotationCanvas = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) {
      setHasAnnotationStrokes(false);
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      setHasAnnotationStrokes(false);
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasAnnotationStrokes(false);
  }, []);

  const cancelDesignCapture = useCallback(() => {
    setSelectionRect(null);
    setHoveredElementCapture(null);
    dragSelectionRef.current = null;
    pendingElementHoverPointRef.current = null;
    setDesignDraft(null);
    setDesignInstructions("");
    clearAnnotationCanvas();
    setIsSubmittingDesignRequest(false);
    onDesignCaptureCancel?.();
  }, [clearAnnotationCanvas, onDesignCaptureCancel]);

  useEffect(() => {
    if (designerModeActive) {
      return;
    }
    if (!designDraft) {
      setSelectionRect(null);
      setHoveredElementCapture(null);
      dragSelectionRef.current = null;
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, designDraft, designerModeActive]);

  useEffect(() => {
    if (designerTool === "element-comment") {
      return;
    }
    pendingElementHoverPointRef.current = null;
    setHoveredElementCapture(null);
  }, [designerTool]);

  useEffect(() => {
    if (!designDraft || designDraft.tool === designerTool) {
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, designDraft, designerTool]);

  useEffect(() => {
    return () => {
      if (elementHoverFrameRef.current !== null) {
        window.cancelAnimationFrame(elementHoverFrameRef.current);
      }
    };
  }, []);

  const startCapturedDraft = useCallback(
    (
      selection: BrowserDesignSelectionRect,
      inspectedPoint?: BrowserPageElementCapture | null,
      failureMessage = "Could not capture the selected browser area.",
    ) => {
      setSelectionRect(selection);
      const requestId = generateDesignRequestId();
      const host = overlayRef.current;
      const viewportWidth = host?.clientWidth ?? 0;
      const viewportHeight = host?.clientHeight ?? 0;
      void captureDesignSelection(selection, requestId, inspectedPoint)
        .then((capture) => {
          setDesignInstructions("");
          clearAnnotationCanvas();
          setDesignDraft({
            capture,
            tool: designerTool,
            viewportWidth,
            viewportHeight,
          });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : failureMessage;
          onDesignCaptureError?.(message);
          cancelDesignCapture();
        });
    },
    [
      cancelDesignCapture,
      captureDesignSelection,
      clearAnnotationCanvas,
      designerTool,
      onDesignCaptureError,
    ],
  );

  const startViewportDraft = useCallback(
    (failureMessage = "Could not capture the current page.") => {
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      startCapturedDraft(
        {
          x: 0,
          y: 0,
          width: Math.max(1, Math.round(host.clientWidth)),
          height: Math.max(1, Math.round(host.clientHeight)),
        },
        null,
        failureMessage,
      );
    },
    [startCapturedDraft],
  );

  const flushHoveredElementInspection = useCallback(() => {
    if (elementHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(elementHoverFrameRef.current);
      elementHoverFrameRef.current = null;
    }
    if (
      elementHoverRequestInFlightRef.current ||
      !designerModeActive ||
      designerTool !== "element-comment" ||
      designDraft
    ) {
      return;
    }
    const point = pendingElementHoverPointRef.current;
    if (!point) {
      return;
    }
    pendingElementHoverPointRef.current = null;
    elementHoverRequestInFlightRef.current = true;
    void inspectBrowserPoint(point)
      .then((capture) => {
        setHoveredElementCapture(capture);
      })
      .finally(() => {
        elementHoverRequestInFlightRef.current = false;
        if (pendingElementHoverPointRef.current) {
          elementHoverFrameRef.current = window.requestAnimationFrame(
            flushHoveredElementInspection,
          );
        }
      });
  }, [designDraft, designerModeActive, designerTool, inspectBrowserPoint]);

  const onCaptureOverlayPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!designerModeActive || designDraft || event.button !== 0) {
        return;
      }
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      const startX = event.clientX - bounds.left;
      const startY = event.clientY - bounds.top;
      if (designerTool === "draw-comment") {
        event.preventDefault();
        event.stopPropagation();
        startViewportDraft();
        return;
      }
      if (designerTool === "element-comment") {
        pendingElementHoverPointRef.current = { x: startX, y: startY };
        flushHoveredElementInspection();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      dragSelectionRef.current = {
        pointerId: event.pointerId,
        startX,
        startY,
        hostWidth: host.clientWidth,
        hostHeight: host.clientHeight,
      };
      const initialRect = normalizeSelectionRect({
        startX,
        startY,
        currentX: startX,
        currentY: startY,
        hostWidth: host.clientWidth,
        hostHeight: host.clientHeight,
      });
      setSelectionRect(initialRect);
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [
      designDraft,
      designerModeActive,
      designerTool,
      flushHoveredElementInspection,
      startViewportDraft,
    ],
  );

  const onCaptureOverlayPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragSelection = dragSelectionRef.current;
      if (dragSelection && dragSelection.pointerId === event.pointerId) {
        const host = overlayRef.current;
        if (!host) {
          return;
        }
        const bounds = host.getBoundingClientRect();
        setSelectionRect(
          normalizeSelectionRect({
            startX: dragSelection.startX,
            startY: dragSelection.startY,
            currentX: event.clientX - bounds.left,
            currentY: event.clientY - bounds.top,
            hostWidth: dragSelection.hostWidth,
            hostHeight: dragSelection.hostHeight,
          }),
        );
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!designerModeActive || designerTool !== "element-comment" || designDraft) {
        return;
      }
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      pendingElementHoverPointRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      if (elementHoverFrameRef.current === null) {
        elementHoverFrameRef.current = window.requestAnimationFrame(flushHoveredElementInspection);
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [designDraft, designerModeActive, designerTool, flushHoveredElementInspection],
  );

  const onCaptureOverlayPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragSelection = dragSelectionRef.current;
      if (dragSelection && dragSelection.pointerId === event.pointerId) {
        dragSelectionRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        const finalSelection = selectionRect;
        if (
          !finalSelection ||
          finalSelection.width < MIN_CAPTURE_SIZE_PX ||
          finalSelection.height < MIN_CAPTURE_SIZE_PX
        ) {
          setSelectionRect(null);
          return;
        }
        startCapturedDraft(finalSelection);
        return;
      }

      if (
        !designerModeActive ||
        designerTool !== "element-comment" ||
        designDraft ||
        event.button !== 0
      ) {
        return;
      }
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      const point = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      event.preventDefault();
      event.stopPropagation();
      void inspectBrowserPoint(point)
        .then((capture) => {
          const selection = capture?.targetRect ?? null;
          if (
            !selection ||
            selection.width < MIN_CAPTURE_SIZE_PX ||
            selection.height < MIN_CAPTURE_SIZE_PX
          ) {
            throw new Error("Click a visible page element to leave a comment.");
          }
          setHoveredElementCapture(capture);
          startCapturedDraft(selection, capture, "Could not capture the selected page element.");
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Could not capture the selected page element.";
          onDesignCaptureError?.(message);
        });
    },
    [
      designDraft,
      designerModeActive,
      designerTool,
      inspectBrowserPoint,
      onDesignCaptureError,
      selectionRect,
      startCapturedDraft,
    ],
  );

  const buildAnnotatedPreviewCapture = useCallback(async () => {
    if (!designDraft) {
      return null;
    }
    if (!hasAnnotationStrokes) {
      return {
        imageDataUrl: designDraft.capture.imageDataUrl,
        imageMimeType: designDraft.capture.imageMimeType,
        imageSizeBytes: designDraft.capture.imageSizeBytes,
      };
    }
    const canvas = annotationCanvasRef.current;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
      return {
        imageDataUrl: designDraft.capture.imageDataUrl,
        imageMimeType: designDraft.capture.imageMimeType,
        imageSizeBytes: designDraft.capture.imageSizeBytes,
      };
    }
    const image = new Image();
    const baseImageLoaded = new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("Unable to prepare the comment capture.")),
        { once: true },
      );
    });
    image.src = designDraft.capture.imageDataUrl;
    await baseImageLoaded;
    const composedCanvas = document.createElement("canvas");
    composedCanvas.width = canvas.width;
    composedCanvas.height = canvas.height;
    const context = composedCanvas.getContext("2d");
    if (!context) {
      return {
        imageDataUrl: designDraft.capture.imageDataUrl,
        imageMimeType: designDraft.capture.imageMimeType,
        imageSizeBytes: designDraft.capture.imageSizeBytes,
      };
    }
    const selection = designDraft.capture.selection;
    composedCanvas.width = selection.width;
    composedCanvas.height = selection.height;
    context.drawImage(image, 0, 0, composedCanvas.width, composedCanvas.height);
    context.drawImage(
      canvas,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      0,
      0,
      composedCanvas.width,
      composedCanvas.height,
    );
    const imageDataUrl = composedCanvas.toDataURL("image/png");
    return {
      imageDataUrl,
      imageMimeType: "image/png",
      imageSizeBytes: estimateDataUrlBytes(imageDataUrl),
    };
  }, [designDraft, hasAnnotationStrokes]);

  const submitDesignDraft = useCallback(async () => {
    if (!designDraft || !onDesignCaptureSubmit || isSubmittingDesignRequest) {
      return;
    }
    const trimmedInstructions = designInstructions.trim();
    if (trimmedInstructions.length === 0) {
      return;
    }
    setIsSubmittingDesignRequest(true);
    try {
      const annotatedPreview = await buildAnnotatedPreviewCapture();
      const capturePayload = annotatedPreview ?? designDraft.capture;
      await onDesignCaptureSubmit({
        ...designDraft.capture,
        ...capturePayload,
        instructions: trimmedInstructions,
      });
      cancelDesignCapture();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add the comment.";
      onDesignCaptureError?.(message);
    } finally {
      setIsSubmittingDesignRequest(false);
    }
  }, [
    buildAnnotatedPreviewCapture,
    cancelDesignCapture,
    designDraft,
    designInstructions,
    isSubmittingDesignRequest,
    onDesignCaptureError,
    onDesignCaptureSubmit,
  ]);

  useEffect(() => {
    if (!designDraft) {
      clearAnnotationCanvas();
      return;
    }
    const syncCanvas = () => {
      const overlay = overlayRef.current;
      const canvas = annotationCanvasRef.current;
      if (!overlay || !canvas) {
        return;
      }
      const nextWidth = Math.max(1, Math.round(overlay.clientWidth));
      const nextHeight = Math.max(1, Math.round(overlay.clientHeight));
      if (canvas.width === nextWidth && canvas.height === nextHeight) {
        return;
      }
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      clearAnnotationCanvas();
    };
    syncCanvas();
    const overlay = overlayRef.current;
    const observer =
      overlay && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncCanvas();
          })
        : null;
    if (observer && overlay) {
      observer.observe(overlay);
    }
    return () => {
      observer?.disconnect();
    };
  }, [clearAnnotationCanvas, designDraft]);

  const drawAnnotationStroke = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const canvas = annotationCanvasRef.current;
      if (!canvas) {
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 4;
      context.strokeStyle = "#ff6b57";
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      setHasAnnotationStrokes(true);
    },
    [],
  );

  const resolveAnnotationPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) {
      return null;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }, []);

  const handleAnnotationPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0 || !designDraft) {
        return;
      }
      const point = resolveAnnotationPoint(event);
      const selection = designDraft.capture.selection;
      if (!point || !isPointInsideSelectionRect(point, selection)) {
        return;
      }
      annotationPointerRef.current = {
        pointerId: event.pointerId,
        lastX: point.x,
        lastY: point.y,
      };
      drawAnnotationStroke(point, point);
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [designDraft, drawAnnotationStroke, resolveAnnotationPoint],
  );

  const handleAnnotationPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drawingState = annotationPointerRef.current;
      if (!drawingState || drawingState.pointerId !== event.pointerId || !designDraft) {
        return;
      }
      const point = resolveAnnotationPoint(event);
      if (!point) {
        return;
      }
      const selection = designDraft.capture.selection;
      const nextPoint = {
        x: clampPoint(point.x, selection.x, selection.x + selection.width),
        y: clampPoint(point.y, selection.y, selection.y + selection.height),
      };
      drawAnnotationStroke({ x: drawingState.lastX, y: drawingState.lastY }, nextPoint);
      annotationPointerRef.current = {
        ...drawingState,
        lastX: nextPoint.x,
        lastY: nextPoint.y,
      };
      event.preventDefault();
    },
    [designDraft, drawAnnotationStroke, resolveAnnotationPoint],
  );

  const handleAnnotationPointerEnd = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drawingState = annotationPointerRef.current;
    if (!drawingState || drawingState.pointerId !== event.pointerId) {
      return;
    }
    annotationPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const designRequestPanelStyle = useMemo<CSSProperties | undefined>(() => {
    if (!designDraft) {
      return undefined;
    }
    if (designDraft.tool === "draw-comment") {
      return {
        left: 16,
        top: Math.max(16, designDraft.viewportHeight - DESIGN_REQUEST_PANEL_HEIGHT_PX - 16),
      };
    }
    const selection = designDraft.capture.selection;
    const viewportWidth = designDraft.viewportWidth;
    const viewportHeight = designDraft.viewportHeight;
    const desiredX = selection.x + selection.width + 12;
    const desiredY = selection.y;
    const fallbackY = selection.y + selection.height + 10;
    const left = clampPoint(
      desiredX,
      8,
      Math.max(8, viewportWidth - DESIGN_REQUEST_PANEL_WIDTH_PX - 8),
    );
    const top = clampPoint(
      desiredY,
      8,
      Math.max(8, viewportHeight - DESIGN_REQUEST_PANEL_HEIGHT_PX - 8),
    );
    if (desiredX <= viewportWidth - DESIGN_REQUEST_PANEL_WIDTH_PX - 8) {
      return { left, top };
    }
    return {
      left: clampPoint(
        selection.x,
        8,
        Math.max(8, viewportWidth - DESIGN_REQUEST_PANEL_WIDTH_PX - 8),
      ),
      top: clampPoint(
        fallbackY,
        8,
        Math.max(8, viewportHeight - DESIGN_REQUEST_PANEL_HEIGHT_PX - 8),
      ),
    };
  }, [designDraft]);
  const activeOverlaySelection =
    designerTool === "draw-comment" || designDraft?.tool === "draw-comment"
      ? null
      : (selectionRect ??
        (designerTool === "element-comment" ? (hoveredElementCapture?.targetRect ?? null) : null));

  return (
    <div
      aria-hidden={!active}
      className={cn("absolute inset-0 min-h-0 [&_webview]:size-full", active ? "block" : "hidden")}
    >
      <div ref={hostRef} className="size-full min-h-0" />
      {(designerModeActive || activeOverlaySelection || designDraft) && (
        <div
          ref={overlayRef}
          className={cn(
            "absolute inset-0 z-20",
            designerModeActive || designDraft ? "pointer-events-auto" : "pointer-events-none",
            !designDraft && designerModeActive
              ? designerTool === "element-comment"
                ? "cursor-cell"
                : designerTool === "draw-comment"
                  ? "cursor-crosshair"
                  : "cursor-crosshair"
              : null,
          )}
          onPointerDown={onCaptureOverlayPointerDown}
          onPointerMove={onCaptureOverlayPointerMove}
          onPointerUp={onCaptureOverlayPointerEnd}
          onPointerCancel={onCaptureOverlayPointerEnd}
        >
          {designDraft ? (
            <canvas
              ref={annotationCanvasRef}
              className="absolute inset-0 z-10 size-full touch-none"
              onPointerDown={handleAnnotationPointerDown}
              onPointerMove={handleAnnotationPointerMove}
              onPointerUp={handleAnnotationPointerEnd}
              onPointerCancel={handleAnnotationPointerEnd}
            />
          ) : null}
          {activeOverlaySelection && (
            <div
              className="pointer-events-none absolute rounded-[24px] border border-primary/65 bg-linear-to-br from-primary/[0.14] via-primary/[0.05] to-transparent shadow-[0_28px_90px_-42px_rgba(91,106,255,0.85)]"
              style={{
                left: `${activeOverlaySelection.x}px`,
                top: `${activeOverlaySelection.y}px`,
                width: `${activeOverlaySelection.width}px`,
                height: `${activeOverlaySelection.height}px`,
              }}
            >
              <div className="absolute inset-[1px] rounded-[22px] border border-white/55" />
              <div className="absolute -top-1.5 -left-1.5 size-3 rounded-full border border-white/70 bg-primary shadow-sm" />
              <div className="absolute -top-1.5 -right-1.5 size-3 rounded-full border border-white/70 bg-primary shadow-sm" />
              <div className="absolute -bottom-1.5 -left-1.5 size-3 rounded-full border border-white/70 bg-primary shadow-sm" />
              <div className="absolute -right-1.5 -bottom-1.5 size-3 rounded-full border border-white/70 bg-primary shadow-sm" />
            </div>
          )}
          {designDraft && designRequestPanelStyle && (
            <form
              className="absolute z-30 w-[272px] rounded-[20px] border border-border/60 bg-background/95 p-2.5 shadow-[0_28px_80px_-52px_rgba(0,0,0,0.88)] backdrop-blur-xl"
              style={designRequestPanelStyle}
              onSubmit={(event) => {
                event.preventDefault();
                void submitDesignDraft();
              }}
            >
              <textarea
                value={designInstructions}
                onChange={(event) => setDesignInstructions(event.target.value)}
                placeholder="Comment for the agent"
                className="h-[78px] w-full resize-none rounded-[16px] border border-border/60 bg-background/92 px-3 py-2.5 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-primary/45"
                autoFocus
              />
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={clearAnnotationCanvas}
                    className="inline-flex size-8 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                    disabled={!hasAnnotationStrokes}
                    aria-label="Clear drawing"
                    title="Clear drawing"
                  >
                    <RotateCcwIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelDesignCapture}
                    className="inline-flex size-8 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground transition-colors hover:text-foreground"
                    disabled={isSubmittingDesignRequest}
                    aria-label="Cancel comment"
                    title="Cancel comment"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                  disabled={isSubmittingDesignRequest || designInstructions.trim().length === 0}
                >
                  <CheckIcon className="size-3.5" />
                  Comment
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
