import { GlobeIcon } from "lucide-react";
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
  viewportWidth: number;
  viewportHeight: number;
}

const MIN_CAPTURE_SIZE_PX = 24;
const DESIGN_REQUEST_PANEL_WIDTH_PX = 320;
const DESIGN_REQUEST_PANEL_HEIGHT_PX = 188;

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
  const x = Math.max(0, Math.floor(point.x));
  const y = Math.max(0, Math.floor(point.y));
  const target = document.elementFromPoint(x, y);
  const mainContainer =
    target instanceof Element
      ? target.closest("main, [role='main'], article, section, [data-testid], [class*='container'], [class*='content']") ?? target.parentElement
      : null;
  return {
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
  designCaptureArmed?: boolean;
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
    designCaptureArmed = false,
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
  const dragSelectionRef = useRef<ActiveDragSelection | null>(null);
  const requestedUrlRef = useRef(tab.url);
  const [selectionRect, setSelectionRect] = useState<BrowserDesignSelectionRect | null>(null);
  const [designDraft, setDesignDraft] = useState<BrowserDesignCaptureDraft | null>(null);
  const [designInstructions, setDesignInstructions] = useState("");
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

  const captureDesignSelection = useCallback(
    async (
      selection: BrowserDesignSelectionRect,
      requestId: string,
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
      const elementCapture = await webview.executeJavaScript<BrowserPageElementCapture | null>(
        buildBrowserElementCaptureScript(centerPoint),
        true,
      );

      return {
        requestId,
        selection,
        imageDataUrl,
        imageMimeType: resolveDataUrlMimeType(imageDataUrl),
        imageSizeBytes: estimateDataUrlBytes(imageDataUrl),
        targetElement: normalizeCapturedDescriptor(elementCapture?.target ?? null),
        mainContainer: normalizeCapturedDescriptor(elementCapture?.mainContainer ?? null),
      };
    },
    [],
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

  const cancelDesignCapture = useCallback(() => {
    setSelectionRect(null);
    dragSelectionRef.current = null;
    setDesignDraft(null);
    setDesignInstructions("");
    setIsSubmittingDesignRequest(false);
    onDesignCaptureCancel?.();
  }, [onDesignCaptureCancel]);

  useEffect(() => {
    if (designCaptureArmed) {
      return;
    }
    if (!designDraft) {
      setSelectionRect(null);
      dragSelectionRef.current = null;
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, designCaptureArmed, designDraft]);

  const onCaptureOverlayPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!designCaptureArmed || designDraft || event.button !== 0) {
        return;
      }
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      const startX = event.clientX - bounds.left;
      const startY = event.clientY - bounds.top;
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
    [designCaptureArmed, designDraft],
  );

  const onCaptureOverlayPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragSelection = dragSelectionRef.current;
    if (!dragSelection || dragSelection.pointerId !== event.pointerId) {
      return;
    }
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
  }, []);

  const onCaptureOverlayPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragSelection = dragSelectionRef.current;
      if (!dragSelection || dragSelection.pointerId !== event.pointerId) {
        return;
      }
      dragSelectionRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      const finalSelection = selectionRect;
      setSelectionRect(null);
      if (
        !finalSelection ||
        finalSelection.width < MIN_CAPTURE_SIZE_PX ||
        finalSelection.height < MIN_CAPTURE_SIZE_PX
      ) {
        return;
      }
      const requestId = generateDesignRequestId();
      const host = overlayRef.current;
      const viewportWidth = host?.clientWidth ?? 0;
      const viewportHeight = host?.clientHeight ?? 0;
      void captureDesignSelection(finalSelection, requestId)
        .then((capture) => {
          setDesignInstructions("");
          setDesignDraft({
            capture,
            viewportWidth,
            viewportHeight,
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Could not capture the selected browser area.";
          onDesignCaptureError?.(message);
          cancelDesignCapture();
        });
    },
    [cancelDesignCapture, captureDesignSelection, onDesignCaptureError, selectionRect],
  );

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
      await onDesignCaptureSubmit({
        ...designDraft.capture,
        instructions: trimmedInstructions,
      });
      cancelDesignCapture();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not queue the captured design request.";
      onDesignCaptureError?.(message);
    } finally {
      setIsSubmittingDesignRequest(false);
    }
  }, [
    cancelDesignCapture,
    designDraft,
    designInstructions,
    isSubmittingDesignRequest,
    onDesignCaptureError,
    onDesignCaptureSubmit,
  ]);

  const designRequestPanelStyle = useMemo<CSSProperties | undefined>(() => {
    if (!designDraft) {
      return undefined;
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

  return (
    <div
      aria-hidden={!active}
      className={cn("absolute inset-0 min-h-0 [&_webview]:size-full", active ? "block" : "hidden")}
    >
      <div ref={hostRef} className="size-full min-h-0" />
      {(designCaptureArmed || selectionRect || designDraft) && (
        <div
          ref={overlayRef}
          className={cn(
            "absolute inset-0 z-20",
            designCaptureArmed || designDraft ? "pointer-events-auto" : "pointer-events-none",
          )}
          onPointerDown={onCaptureOverlayPointerDown}
          onPointerMove={onCaptureOverlayPointerMove}
          onPointerUp={onCaptureOverlayPointerEnd}
          onPointerCancel={onCaptureOverlayPointerEnd}
        >
          {designCaptureArmed && !designDraft && (
            <div className="pointer-events-none absolute inset-0 bg-foreground/[0.02]" />
          )}
          {selectionRect && (
            <div
              className="pointer-events-none absolute border-2 border-primary bg-primary/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]"
              style={{
                left: `${selectionRect.x}px`,
                top: `${selectionRect.y}px`,
                width: `${selectionRect.width}px`,
                height: `${selectionRect.height}px`,
              }}
            />
          )}
          {designDraft && designRequestPanelStyle && (
            <form
              className="absolute z-30 w-80 rounded-xl border border-border/70 bg-card/96 p-3 shadow-xl backdrop-blur"
              style={designRequestPanelStyle}
              onSubmit={(event) => {
                event.preventDefault();
                void submitDesignDraft();
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="rounded-full border border-primary/35 bg-primary/12 px-2 py-0.5 font-mono text-[10px] font-medium text-primary/85">
                  {designDraft.capture.requestId}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {Math.max(0, Math.round(designDraft.capture.imageSizeBytes / 1024))} KB
                </span>
              </div>
              <textarea
                value={designInstructions}
                onChange={(event) => setDesignInstructions(event.target.value)}
                placeholder="What should be redesigned in this selected area?"
                className="h-24 w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none transition-colors focus:border-primary/45"
                autoFocus
              />
              <div className="mt-2.5 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={cancelDesignCapture}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  disabled={isSubmittingDesignRequest}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                  disabled={isSubmittingDesignRequest || designInstructions.trim().length === 0}
                >
                  {isSubmittingDesignRequest ? "Queueing..." : "Queue request"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
