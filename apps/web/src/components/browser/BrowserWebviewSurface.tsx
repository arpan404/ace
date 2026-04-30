import { ArrowUpRightIcon, GlobeIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { runAsyncTask } from "~/lib/async";
import type { BrowserDesignerTool } from "~/lib/browser/designer";
import { type BrowserTabState, resolveBrowserTabTitle } from "~/lib/browser/session";
import {
  type BrowserDesignCaptureResult,
  type BrowserDesignCaptureSubmission,
  type BrowserDesignElementDescriptor,
  type BrowserDesignSelectionRect,
  type BrowserTabHandle,
  type BrowserTabSnapshotOptions,
  type BrowserTabSnapshot,
  type BrowserWebview,
  IN_APP_BROWSER_PARTITION,
} from "~/lib/browser/types";
import {
  normalizeBrowserHttpUrl,
  resolveBrowserDisplayUrl,
  resolveBrowserRelayUrl,
} from "~/lib/browser/url";
import { resolveLocalConnectionUrl } from "~/lib/connectionRouting";
import { useEffectEvent } from "~/hooks/useEffectEvent";

const BROWSER_ZOOM_STEP = 0.1;
const MIN_BROWSER_ZOOM_FACTOR = 0.25;
const MAX_BROWSER_ZOOM_FACTOR = 3;

export function isAbortedWebviewLoad(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    ("code" in error && error.code === "ERR_ABORTED") ||
    ("errno" in error && error.errno === -3) ||
    /\bERR_ABORTED\b|\(-3\)\s+loading\b/u.test(error.message)
  );
}

function loadWebviewUrl(
  webview: BrowserWebview,
  url: string,
  onError?: (message: string) => void,
): void {
  void webview.loadURL(url).catch((error: unknown) => {
    if (isAbortedWebviewLoad(error)) {
      return;
    }
    const message = error instanceof Error ? error.message : "Could not load the requested page.";
    onError?.(message);
  });
}

function clampBrowserZoomFactor(factor: number): number {
  return Math.max(MIN_BROWSER_ZOOM_FACTOR, Math.min(MAX_BROWSER_ZOOM_FACTOR, factor));
}

function getWebviewZoomFactor(webview: BrowserWebview): number {
  const factor = webview.getZoomFactor?.();
  return typeof factor === "number" && Number.isFinite(factor) ? factor : 1;
}

function setWebviewZoomFactor(webview: BrowserWebview, factor: number): void {
  webview.setZoomFactor?.(clampBrowserZoomFactor(factor));
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

type AnnotationTool = "ellipse" | "eraser" | "line" | "pencil" | "rectangle";

interface AnnotationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayViewportSize {
  width: number;
  height: number;
}

interface DesignRequestPanelPosition {
  left: number;
  top: number;
}

interface FloatingOverlaySize {
  width: number;
  height: number;
}

const MIN_CAPTURE_SIZE_PX = 24;
const MIN_ELEMENT_CAPTURE_SIZE_PX = 8;
const DESIGN_REQUEST_PANEL_WIDTH_PX = 272;
const DESIGN_REQUEST_PANEL_HEIGHT_PX = 166;
const DESIGN_REQUEST_PANEL_MARGIN_PX = 8;
const BROWSER_SNAPSHOT_COALESCE_MS = 150;
const DEFAULT_DESIGN_REQUEST_PANEL_SIZE: FloatingOverlaySize = {
  width: DESIGN_REQUEST_PANEL_WIDTH_PX,
  height: DESIGN_REQUEST_PANEL_HEIGHT_PX,
};
const DRAW_COLOR_SWATCHES: readonly string[] = [
  "#4F8CFF",
  "#FF6B57",
  "#FDBA32",
  "#32D399",
  "#F472B6",
  "#F8FAFC",
];
const DEFAULT_ANNOTATION_COLOR = DRAW_COLOR_SWATCHES[0] ?? "#4F8CFF";

function clampPoint(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampDesignRequestPanelPosition(
  position: DesignRequestPanelPosition,
  viewport: OverlayViewportSize,
  panelSize: FloatingOverlaySize = DEFAULT_DESIGN_REQUEST_PANEL_SIZE,
): DesignRequestPanelPosition {
  return {
    left: clampPoint(
      position.left,
      DESIGN_REQUEST_PANEL_MARGIN_PX,
      Math.max(
        DESIGN_REQUEST_PANEL_MARGIN_PX,
        viewport.width - panelSize.width - DESIGN_REQUEST_PANEL_MARGIN_PX,
      ),
    ),
    top: clampPoint(
      position.top,
      DESIGN_REQUEST_PANEL_MARGIN_PX,
      Math.max(
        DESIGN_REQUEST_PANEL_MARGIN_PX,
        viewport.height - panelSize.height - DESIGN_REQUEST_PANEL_MARGIN_PX,
      ),
    ),
  };
}

function resolveAnchoredDesignRequestPanelPosition(
  position: DesignRequestPanelPosition,
  previousViewport: OverlayViewportSize,
  nextViewport: OverlayViewportSize,
  previousPanelSize: FloatingOverlaySize,
  nextPanelSize: FloatingOverlaySize,
): DesignRequestPanelPosition {
  const previousMaxLeft = Math.max(
    DESIGN_REQUEST_PANEL_MARGIN_PX,
    previousViewport.width - previousPanelSize.width - DESIGN_REQUEST_PANEL_MARGIN_PX,
  );
  const previousMaxTop = Math.max(
    DESIGN_REQUEST_PANEL_MARGIN_PX,
    previousViewport.height - previousPanelSize.height - DESIGN_REQUEST_PANEL_MARGIN_PX,
  );
  const nextMaxLeft = Math.max(
    DESIGN_REQUEST_PANEL_MARGIN_PX,
    nextViewport.width - nextPanelSize.width - DESIGN_REQUEST_PANEL_MARGIN_PX,
  );
  const nextMaxTop = Math.max(
    DESIGN_REQUEST_PANEL_MARGIN_PX,
    nextViewport.height - nextPanelSize.height - DESIGN_REQUEST_PANEL_MARGIN_PX,
  );
  const leftOffset = Math.max(0, position.left - DESIGN_REQUEST_PANEL_MARGIN_PX);
  const rightOffset = Math.max(0, previousMaxLeft - position.left);
  const topOffset = Math.max(0, position.top - DESIGN_REQUEST_PANEL_MARGIN_PX);
  const bottomOffset = Math.max(0, previousMaxTop - position.top);

  return clampDesignRequestPanelPosition(
    {
      left:
        rightOffset <= leftOffset
          ? nextMaxLeft - rightOffset
          : DESIGN_REQUEST_PANEL_MARGIN_PX + leftOffset,
      top:
        bottomOffset <= topOffset
          ? nextMaxTop - bottomOffset
          : DESIGN_REQUEST_PANEL_MARGIN_PX + topOffset,
    },
    nextViewport,
    nextPanelSize,
  );
}

function resolveDefaultDesignRequestPanelPosition(
  draft: BrowserDesignCaptureDraft,
  viewport: OverlayViewportSize,
  panelSize: FloatingOverlaySize = DEFAULT_DESIGN_REQUEST_PANEL_SIZE,
): DesignRequestPanelPosition {
  if (draft.tool === "draw-comment") {
    return clampDesignRequestPanelPosition(
      {
        left: Math.max(16, viewport.width - panelSize.width - 16),
        top: Math.max(16, viewport.height - panelSize.height - 16),
      },
      viewport,
      panelSize,
    );
  }
  const selection = draft.capture.selection;
  const desiredX = selection.x + selection.width + 12;
  const desiredY = selection.y;
  const fallbackY = selection.y + selection.height + 10;
  if (desiredX <= viewport.width - panelSize.width - DESIGN_REQUEST_PANEL_MARGIN_PX) {
    return clampDesignRequestPanelPosition(
      {
        left: desiredX,
        top: desiredY,
      },
      viewport,
      panelSize,
    );
  }
  return clampDesignRequestPanelPosition(
    {
      left: selection.x,
      top: fallbackY,
    },
    viewport,
    panelSize,
  );
}

function resolveAnnotationBounds(
  draft: BrowserDesignCaptureDraft,
  canvas: HTMLCanvasElement | null,
): AnnotationBounds {
  if (draft.tool === "draw-comment") {
    return {
      x: 0,
      y: 0,
      width: Math.max(1, canvas?.width ?? draft.capture.selection.width),
      height: Math.max(1, canvas?.height ?? draft.capture.selection.height),
    };
  }
  return draft.capture.selection;
}

function isPointInsideSelectionRect(
  point: { x: number; y: number },
  rect: BrowserDesignSelectionRect | null,
): boolean {
  if (!rect) {
    return false;
  }
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
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

export function mapSelectionRectToCapturedImageCrop(input: {
  selection: BrowserDesignSelectionRect;
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
}): BrowserDesignSelectionRect {
  const viewportWidth = Math.max(1, input.viewportWidth);
  const viewportHeight = Math.max(1, input.viewportHeight);
  const imageWidth = Math.max(1, input.imageWidth);
  const imageHeight = Math.max(1, input.imageHeight);
  const scaleX = imageWidth / viewportWidth;
  const scaleY = imageHeight / viewportHeight;
  const left = clampPoint(Math.floor(input.selection.x * scaleX), 0, Math.max(0, imageWidth - 1));
  const top = clampPoint(Math.floor(input.selection.y * scaleY), 0, Math.max(0, imageHeight - 1));
  const right = clampPoint(
    Math.ceil((input.selection.x + input.selection.width) * scaleX),
    left + 1,
    imageWidth,
  );
  const bottom = clampPoint(
    Math.ceil((input.selection.y + input.selection.height) * scaleY),
    top + 1,
    imageHeight,
  );
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function hasMinimumSelectionSize(
  rect: BrowserDesignSelectionRect | null | undefined,
  minimumSizePx = MIN_CAPTURE_SIZE_PX,
): rect is BrowserDesignSelectionRect {
  return Boolean(rect && rect.width >= minimumSizePx && rect.height >= minimumSizePx);
}

export function shouldSubmitDesignDraftFromTextareaKey(
  event: Pick<
    ReactKeyboardEvent<HTMLTextAreaElement>,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  > & { isComposing?: boolean },
): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.isComposing !== true
  );
}

export function normalizeDesignCommentToSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function shouldRunElementHoverInspection(input: {
  active: boolean;
  designerModeActive: boolean;
  designerTool: BrowserDesignerTool;
  hasDesignDraft: boolean;
  requestInFlight: boolean;
}): boolean {
  return (
    input.active &&
    input.designerModeActive &&
    input.designerTool === "element-comment" &&
    !input.hasDesignDraft &&
    !input.requestInFlight
  );
}

export function resolveElementCommentWheelForwardingMode(input: {
  hasSendInputEvent: boolean;
  platform: string;
}): "dom-scroll" | "electron-input" {
  if (!input.hasSendInputEvent || isMacPlatform(input.platform)) {
    return "dom-scroll";
  }
  return "electron-input";
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

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Failed to load captured browser image.")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

async function cropCapturedImageDataUrl(input: {
  dataUrl: string;
  selection: BrowserDesignSelectionRect;
  viewportWidth: number;
  viewportHeight: number;
}): Promise<string> {
  const image = await loadImageDataUrl(input.dataUrl);
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("Captured browser image is empty.");
  }
  const crop = mapSelectionRectToCapturedImageCrop({
    imageHeight,
    imageWidth,
    selection: input.selection,
    viewportHeight: input.viewportHeight,
    viewportWidth: input.viewportWidth,
  });
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare selected browser image.");
  }
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return canvas.toDataURL(resolveDataUrlMimeType(input.dataUrl));
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

export function buildBrowserElementCaptureScript(
  point: { x: number; y: number },
  overlayViewport?: { width: number; height: number },
): string {
  const serializedPayload = JSON.stringify({
    overlayViewport: overlayViewport
      ? {
          width: Math.max(1, Math.round(overlayViewport.width)),
          height: Math.max(1, Math.round(overlayViewport.height)),
        }
      : null,
    point: {
      x: Math.max(0, Math.floor(point.x)),
      y: Math.max(0, Math.floor(point.y)),
    },
  });
  return `(() => {
  const payload = ${serializedPayload};
  const rawPoint = payload.point;
  const overlayViewport = payload.overlayViewport;
  const toSnippet = (value, maxLength) => {
    if (typeof value !== "string") return null;
    const collapsed = value.replace(/\\s+/g, " ").trim();
    if (!collapsed) return null;
    return collapsed.length > maxLength ? collapsed.slice(0, maxLength - 1) + "…" : collapsed;
  };
  const parseAlpha = (value) => {
    if (typeof value !== "string") return 0;
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "transparent") return 0;
    const rgbaMatch = normalized.match(/^rgba\\((.+)\\)$/);
    if (!rgbaMatch) return 1;
    const parts = rgbaMatch[1].split(",").map((part) => part.trim());
    if (parts.length < 4) return 1;
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) ? alpha : 1;
  };
  const isElementNode = (value) => Boolean(value) && value.nodeType === 1 && typeof value.tagName === "string";
  const clampNumber = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const escapeCss = (value) => {
    if (typeof value !== "string") return "";
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  };
  const resolveViewportMetrics = () => {
    const visualViewport = typeof window.visualViewport === "object" ? window.visualViewport : null;
    const guestWidth = Math.max(
      1,
      Math.round(
        window.innerWidth || visualViewport?.width || document.documentElement?.clientWidth || 1,
      ),
    );
    const guestHeight = Math.max(
      1,
      Math.round(
        window.innerHeight || visualViewport?.height || document.documentElement?.clientHeight || 1,
      ),
    );
    const hostWidth = Math.max(1, Math.round(overlayViewport?.width || guestWidth));
    const hostHeight = Math.max(1, Math.round(overlayViewport?.height || guestHeight));
    const offsetLeft = Number.isFinite(visualViewport?.offsetLeft) ? visualViewport.offsetLeft : 0;
    const offsetTop = Number.isFinite(visualViewport?.offsetTop) ? visualViewport.offsetTop : 0;
    return {
      guestHeight,
      guestWidth,
      hostHeight,
      hostWidth,
      offsetLeft,
      offsetTop,
      scaleX: guestWidth / hostWidth,
      scaleY: guestHeight / hostHeight,
    };
  };
  const viewport = resolveViewportMetrics();
  const point = {
    x: Math.round(
      clampNumber(
        viewport.offsetLeft + rawPoint.x * viewport.scaleX,
        viewport.offsetLeft,
        viewport.offsetLeft + viewport.guestWidth - 1,
      ),
    ),
    y: Math.round(
      clampNumber(
        viewport.offsetTop + rawPoint.y * viewport.scaleY,
        viewport.offsetTop,
        viewport.offsetTop + viewport.guestHeight - 1,
      ),
    ),
  };
  const mapGuestRectToHost = (rect) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const left = Math.max(0, (rect.left - viewport.offsetLeft) / viewport.scaleX);
    const top = Math.max(0, (rect.top - viewport.offsetTop) / viewport.scaleY);
    const right = Math.max(left + 1, (rect.right - viewport.offsetLeft) / viewport.scaleX);
    const bottom = Math.max(top + 1, (rect.bottom - viewport.offsetTop) / viewport.scaleY);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  };
  const selectorFromElement = (element) => {
    if (!isElementNode(element)) return null;
    if (element.id) return "#" + escapeCss(element.id);
    const segments = [];
    let current = element;
    for (let depth = 0; depth < 4 && current && isElementNode(current); depth += 1) {
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
    if (!isElementNode(element)) return null;
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
    if (!isElementNode(element)) return null;
    return mapGuestRectToHost(element.getBoundingClientRect());
  };
  const toRoundedRect = (rect) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return mapGuestRectToHost(rect);
  };
  const pointWithinRect = (rect) =>
    rect &&
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom;
  const strongPreferredRoles = new Set([
    "article",
    "button",
    "cell",
    "checkbox",
    "gridcell",
    "link",
    "listitem",
    "menuitem",
    "option",
    "radio",
    "row",
    "switch",
    "tab",
  ]);
  const strongPreferredTags = new Set([
    "a",
    "article",
    "button",
    "figure",
    "img",
    "input",
    "label",
    "li",
    "summary",
  ]);
  const weakPreferredTags = new Set(["aside", "header", "nav", "section"]);
  const ignoredLeafTags = new Set(["b", "em", "i", "path", "small", "span", "strong", "svg"]);
  const mediaTags = new Set(["canvas", "figure", "img", "svg", "video"]);
  const textLikeTags = new Set([
    "blockquote",
    "button",
    "figcaption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "label",
    "legend",
    "li",
    "p",
    "span",
    "summary",
    "yt-formatted-string",
  ]);
  const blockDisplays = new Set([
    "block",
    "flex",
    "grid",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "list-item",
  ]);
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const measureTextRect = (element) => {
    if (!isElementNode(element)) return null;
    const textContent = (element.textContent || "").replace(/\\s+/g, " ").trim();
    if (!textContent) return null;
    const range = document.createRange();
    try {
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      if (!pointWithinRect(rect) || rect.width < 6 || rect.height < 6) {
        return null;
      }
      return rect;
    } finally {
      range.detach?.();
    }
  };
  const getMetrics = (element) => {
    if (!isElementNode(element)) return null;
    const rect = element.getBoundingClientRect();
    if (!pointWithinRect(rect) || rect.width < 8 || rect.height < 8) {
      return null;
    }
    const style = window.getComputedStyle(element);
    const tagName = element.tagName.toLowerCase();
    const role = (element.getAttribute("role") || "").toLowerCase();
    const area = rect.width * rect.height;
    const isInline =
      style.display.startsWith("inline") &&
      style.display !== "inline-block" &&
      style.display !== "inline-flex" &&
      style.display !== "inline-grid";
    const hasVisualBox =
      parseAlpha(style.backgroundColor) > 0.04 ||
      style.backgroundImage !== "none" ||
      parseFloat(style.borderTopWidth || "0") > 0 ||
      parseFloat(style.borderRightWidth || "0") > 0 ||
      parseFloat(style.borderBottomWidth || "0") > 0 ||
      parseFloat(style.borderLeftWidth || "0") > 0 ||
      style.boxShadow !== "none" ||
      parseFloat(style.borderRadius || "0") > 0;
    const isInteractive =
      strongPreferredTags.has(tagName) ||
      strongPreferredRoles.has(role) ||
      element.hasAttribute("tabindex") ||
      element.hasAttribute("aria-current") ||
      element.hasAttribute("aria-pressed");
    const textLength = (element.textContent || "").replace(/\\s+/g, " ").trim().length;
    const textRect = measureTextRect(element);
    const childCount = element.childElementCount;
    const isCustomElement = tagName.includes("-");
    const isHuge =
      area > viewportArea * 0.72 ||
      (rect.width > window.innerWidth * 0.97 && rect.height > window.innerHeight * 0.52) ||
      rect.height > window.innerHeight * 0.88;
    return {
      area,
      areaRatio: area / viewportArea,
      childCount,
      display: style.display,
      hasVisualBox,
      isCustomElement,
      isHuge,
      isInline,
      isInteractive,
      rect,
      role,
      tagName,
      textRect,
      textLength,
    };
  };
  const isTextSelectable = (metrics) => {
    if (!metrics || metrics.isHuge || metrics.textLength < 14) {
      return false;
    }
    const selectionRect = metrics.textRect ?? metrics.rect;
    const textArea = selectionRect.width * selectionRect.height;
    if (textArea < 120 || selectionRect.height > window.innerHeight * 0.28) {
      return false;
    }
    if (
      selectionRect.width > window.innerWidth * 0.96 &&
      selectionRect.height > window.innerHeight * 0.18
    ) {
      return false;
    }
    return (
      textLikeTags.has(metrics.tagName) ||
      (!metrics.hasVisualBox && (metrics.childCount <= 3 || blockDisplays.has(metrics.display))) ||
      (!metrics.hasVisualBox &&
        metrics.isCustomElement &&
        metrics.textLength >= 18 &&
        selectionRect.height <= 120)
    );
  };
  const isSurfaceSelectable = (metrics, childMetrics) => {
    if (!metrics || metrics.isHuge) {
      return false;
    }
    const hasOwnSurface =
      metrics.hasVisualBox ||
      mediaTags.has(metrics.tagName) ||
      strongPreferredTags.has(metrics.tagName);
    if (!hasOwnSurface || metrics.area < 900 || metrics.rect.width < 32 || metrics.rect.height < 24) {
      return false;
    }
    if (
      !metrics.isInteractive &&
      metrics.rect.width > window.innerWidth * 0.86 &&
      metrics.rect.height > window.innerHeight * 0.2
    ) {
      return false;
    }
    if (childMetrics?.hasVisualBox && !metrics.isInteractive) {
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      const centeredAlongX =
        Math.abs(
          (metrics.rect.left + metrics.rect.right) / 2 -
            (childMetrics.rect.left + childMetrics.rect.right) / 2,
        ) <= Math.min(48, metrics.rect.width * 0.08);
      if (centeredAlongX && widthGrowth > 1.1 && heightGrowth < 1.4) {
        return false;
      }
    }
    if (isTextSelectable(childMetrics) && !metrics.isInteractive) {
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      if (metrics.hasVisualBox && (widthGrowth > 1.14 || heightGrowth > 1.14)) {
        return false;
      }
    }
    return true;
  };
  const isMeaningfulChild = (metrics) => {
    if (!metrics) return false;
    return (
      metrics.hasVisualBox ||
      metrics.isInteractive ||
      isTextSelectable(metrics) ||
      strongPreferredTags.has(metrics.tagName) ||
      strongPreferredRoles.has(metrics.role) ||
      metrics.area > 2600 ||
      metrics.rect.width >= 120 ||
      metrics.rect.height >= 56 ||
      metrics.textLength >= 40
    );
  };
  const isWeakLeafCandidate = (metrics) => {
    if (!metrics) return false;
    if (
      metrics.isInteractive ||
      metrics.hasVisualBox ||
      strongPreferredTags.has(metrics.tagName) ||
      strongPreferredRoles.has(metrics.role)
    ) {
      return false;
    }
    return (
      ignoredLeafTags.has(metrics.tagName) ||
      (metrics.isInline && metrics.area < 24000) ||
      (metrics.childCount === 0 &&
        metrics.rect.height < 48 &&
        metrics.rect.width < window.innerWidth * 0.55)
    );
  };
  const resolveSelectableCandidate = (element, depth, pathChild) => {
    const metrics = getMetrics(element);
    if (!metrics) return null;
    const childMetrics = getMetrics(pathChild);
    const isTextCandidate = isTextSelectable(metrics);
    const isSurfaceCandidate = isSurfaceSelectable(metrics, childMetrics);
    const isControlCandidate = metrics.isInteractive;
    if (!isControlCandidate && !isTextCandidate && !isSurfaceCandidate) {
      return null;
    }
    const selectionRect =
      isTextCandidate && !metrics.hasVisualBox ? (metrics.textRect ?? metrics.rect) : metrics.rect;
    if (!selectionRect) {
      return null;
    }
    let score = 0;
    if (isControlCandidate) score += 12;
    if (isTextCandidate) score += 10;
    if (isSurfaceCandidate) score += 8;
    if (strongPreferredTags.has(metrics.tagName)) score += 5;
    if (strongPreferredRoles.has(metrics.role)) score += 4;
    if (!isTextCandidate && weakPreferredTags.has(metrics.tagName)) score += 1.5;
    if (metrics.isCustomElement) score += 4;
    if (metrics.hasVisualBox) score += 5;
    if (blockDisplays.has(metrics.display)) score += 3;
    if (metrics.childCount > 0) score += Math.min(2, metrics.childCount * 0.35);
    if (metrics.textLength > 0) score += Math.min(3, Math.ceil(metrics.textLength / 42));
    if (isTextCandidate && metrics.textRect) {
      score += Math.min(6, metrics.textLength / 18);
    }
    if (metrics.isInline) score -= 7;
    if (!isTextCandidate && ignoredLeafTags.has(metrics.tagName)) score -= 4;
    if (metrics.area < 420) score -= 5;
    if (metrics.isHuge) score -= 12;
    if (!metrics.isInteractive && metrics.rect.width > window.innerWidth * 0.8) score -= 3.5;
    if (
      !metrics.isInteractive &&
      metrics.rect.height < window.innerHeight * 0.34 &&
      metrics.rect.width / Math.max(1, metrics.rect.height) > 5.6
    ) {
      score -= 3;
    }
    if (isMeaningfulChild(childMetrics)) {
      const areaGrowth = metrics.area / Math.max(1, childMetrics.area);
      const widthGrowth = metrics.rect.width / Math.max(1, childMetrics.rect.width);
      const heightGrowth = metrics.rect.height / Math.max(1, childMetrics.rect.height);
      const centeredAlongX =
        Math.abs(
          (metrics.rect.left + metrics.rect.right) / 2 -
            (childMetrics.rect.left + childMetrics.rect.right) / 2,
        ) <= Math.min(48, metrics.rect.width * 0.1);
      const similarHeight = heightGrowth <= 1.45;
      if (areaGrowth > 1.45) {
        score -= Math.min(10, (areaGrowth - 1.45) * 4.5);
      }
      if (widthGrowth > 1.16 && similarHeight) {
        score -= Math.min(8, (widthGrowth - 1.16) * 18);
      }
      if (centeredAlongX && widthGrowth > 1.12 && similarHeight) {
        score -= 4;
      }
      if (childMetrics.hasVisualBox && metrics.hasVisualBox && widthGrowth > 1.08) {
        score -= 3;
      }
      if (isTextSelectable(childMetrics) && !isTextCandidate && !metrics.isInteractive) {
        score -= 8;
      }
    }
    score -= depth * 0.45;
    score -= metrics.areaRatio * 8;
    const roundedRect = toRoundedRect(selectionRect);
    if (!roundedRect) {
      return null;
    }
    return {
      depth,
      element,
      rect: roundedRect,
      score,
    };
  };
  const resolveTargetElement = (initialTarget) => {
    if (!isElementNode(initialTarget)) return null;
    const candidates = [];
    const bestCandidateByElement = new Map();
    const resolvePreferredTextCandidate = (elements) => {
      for (const hit of elements.slice(0, 4)) {
        let current = hit;
        for (let depth = 0; current && depth < 4; depth += 1) {
          const metrics = getMetrics(current);
          if (!metrics) {
            break;
          }
          if (isTextSelectable(metrics) && !metrics.hasVisualBox) {
            const rect = toRoundedRect(metrics.textRect ?? metrics.rect);
            if (rect) {
              return {
                depth,
                element: current,
                rect,
                score: Number.POSITIVE_INFINITY,
              };
            }
          }
          if (metrics.hasVisualBox || metrics.isInteractive) {
            break;
          }
          current = current.parentElement;
        }
      }
      return null;
    };
    const considerChain = (start) => {
      let current = start;
      let pathChild = null;
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (isElementNode(current)) {
          const candidate = resolveSelectableCandidate(current, depth, pathChild);
          if (candidate) {
            const existing = bestCandidateByElement.get(current);
            if (!existing || candidate.score > existing.score) {
              bestCandidateByElement.set(current, candidate);
            }
          }
        }
        pathChild = current;
        current = current.parentElement;
      }
    };
    const hitElements =
      typeof document.elementsFromPoint === "function"
        ? document.elementsFromPoint(point.x, point.y)
        : [initialTarget];
    const filteredHitElements = hitElements.filter((element) => {
      return !isWeakLeafCandidate(getMetrics(element));
    });
    const preferredTextCandidate = resolvePreferredTextCandidate(
      filteredHitElements.length > 0 ? filteredHitElements : hitElements,
    );
    if (preferredTextCandidate) {
      return preferredTextCandidate;
    }
    for (const hit of (filteredHitElements.length > 0 ? filteredHitElements : hitElements).slice(0, 6)) {
      considerChain(hit);
    }
    candidates.push(...bestCandidateByElement.values());
    if (candidates.length === 0) {
      return { element: initialTarget, rect: toRect(initialTarget), score: 0, depth: 0 };
    }
    candidates.sort((left, right) => right.score - left.score || left.depth - right.depth);
    return candidates[0] ?? { element: initialTarget, rect: toRect(initialTarget), score: 0, depth: 0 };
  };
  const x = Math.max(0, Math.floor(point.x));
  const y = Math.max(0, Math.floor(point.y));
  const rawTarget = document.elementFromPoint(x, y);
  const resolvedTarget = resolveTargetElement(rawTarget);
  const target = resolvedTarget?.element ?? null;
  const mainContainer =
     isElementNode(target)
       ? target.closest("main, [role='main'], article, section, [data-testid], [class*='container'], [class*='content']") ?? target.parentElement
       : null;
  return {
    targetRect: resolvedTarget?.rect ?? toRect(target),
    target: describe(target),
    mainContainer: describe(mainContainer),
  };
})();`;
}

function buildElementCommentScrollScript(input: {
  deltaX: number;
  deltaY: number;
  overlayViewport?: { width: number; height: number };
  point: { x: number; y: number };
}): string {
  const serializedPayload = JSON.stringify({
    delta: {
      left: input.deltaX,
      top: input.deltaY,
    },
    overlayViewport: input.overlayViewport
      ? {
          width: Math.max(1, Math.round(input.overlayViewport.width)),
          height: Math.max(1, Math.round(input.overlayViewport.height)),
        }
      : null,
    point: {
      x: Math.max(0, Math.floor(input.point.x)),
      y: Math.max(0, Math.floor(input.point.y)),
    },
  });
  return `(() => {
  const payload = ${serializedPayload};
  const delta = payload.delta;
  const rawPoint = payload.point;
  const overlayViewport = payload.overlayViewport;
  const visualViewport = typeof window.visualViewport === "object" ? window.visualViewport : null;
  const guestWidth = Math.max(
    1,
    Math.round(
      window.innerWidth || visualViewport?.width || document.documentElement?.clientWidth || 1,
    ),
  );
  const guestHeight = Math.max(
    1,
    Math.round(
      window.innerHeight || visualViewport?.height || document.documentElement?.clientHeight || 1,
    ),
  );
  const hostWidth = Math.max(1, Math.round(overlayViewport?.width || guestWidth));
  const hostHeight = Math.max(1, Math.round(overlayViewport?.height || guestHeight));
  const offsetLeft = Number.isFinite(visualViewport?.offsetLeft) ? visualViewport.offsetLeft : 0;
  const offsetTop = Number.isFinite(visualViewport?.offsetTop) ? visualViewport.offsetTop : 0;
  const clampNumber = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const point = {
    x: Math.round(
      clampNumber(
        offsetLeft + rawPoint.x * (guestWidth / hostWidth),
        offsetLeft,
        offsetLeft + guestWidth - 1,
      ),
    ),
    y: Math.round(
      clampNumber(
        offsetTop + rawPoint.y * (guestHeight / hostHeight),
        offsetTop,
        offsetTop + guestHeight - 1,
      ),
    ),
  };
  const isScrollableOverflow = (value) =>
    value === "auto" || value === "scroll" || value === "overlay";
  const canScrollAxis = (element, axis, amount) => {
    if (!element || amount === 0) return false;
    const style = window.getComputedStyle(element);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (!isScrollableOverflow(overflow)) return false;
    const scrollPosition = axis === "x" ? element.scrollLeft : element.scrollTop;
    const scrollSize = axis === "x" ? element.scrollWidth : element.scrollHeight;
    const clientSize = axis === "x" ? element.clientWidth : element.clientHeight;
    const maxScroll = Math.max(0, scrollSize - clientSize);
    if (maxScroll <= 0) return false;
    return amount > 0 ? scrollPosition < maxScroll : scrollPosition > 0;
  };
  const canScroll = (element, axis) => {
    if (axis === "x") {
      return canScrollAxis(element, "x", delta.left) || canScrollAxis(element, "y", delta.top);
    }
    return canScrollAxis(element, "y", delta.top) || canScrollAxis(element, "x", delta.left);
  };
  const dominantAxis = Math.abs(delta.left) > Math.abs(delta.top) ? "x" : "y";
  let target = document.elementFromPoint(point.x, point.y);
  while (target && target !== document.body && target !== document.documentElement) {
    if (canScroll(target, dominantAxis)) {
      target.scrollBy({ left: delta.left, top: delta.top, behavior: "smooth" });
      return;
    }
    target = target.parentElement;
  }
  window.scrollBy({
    left: delta.left,
    top: delta.top,
    behavior: "smooth",
  });
})();`;
}

function generateDesignRequestId(): string {
  return `DR-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function stopWebviewBeforeRemoval(webview: BrowserWebview): void {
  try {
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools();
    }
  } catch {
    // The guest may already be torn down by Chromium.
  }

  try {
    webview.stop();
  } catch {
    // The guest may already be torn down by Chromium.
  }
}

function DrawingToolIcon(props: { tool: AnnotationTool; className?: string }) {
  const { className, tool } = props;
  switch (tool) {
    case "eraser":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={className}
        >
          <path d="M6.5 14.5 13 8a2.5 2.5 0 0 1 3.5 0l1.5 1.5a2.5 2.5 0 0 1 0 3.5l-4.5 4.5H9.5l-3-3a2.5 2.5 0 0 1 0-3.5Z" />
          <path d="M13.5 17.5h5" />
        </svg>
      );
    case "line":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={className}
        >
          <path d="M5 19 19 5" />
          <circle cx="6.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "rectangle":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={className}
        >
          <rect x="5" y="7" width="14" height="10" rx="2.5" />
        </svg>
      );
    case "ellipse":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={className}
        >
          <ellipse cx="12" cy="12" rx="7" ry="5" />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={className}
        >
          <path d="M6 18 16.5 7.5a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L9 21H6v-3Z" />
          <path d="m14 10 3 3" />
        </svg>
      );
  }
}

const DRAW_TOOL_OPTIONS: ReadonlyArray<{
  label: string;
  tool: AnnotationTool;
}> = [
  { label: "Pencil", tool: "pencil" },
  { label: "Line", tool: "line" },
  { label: "Rectangle", tool: "rectangle" },
  { label: "Ellipse", tool: "ellipse" },
  { label: "Eraser", tool: "eraser" },
];

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
  connectionUrl?: string | null | undefined;
  designerModeActive?: boolean;
  designerTool?: BrowserDesignerTool;
  onBrowserLoadError?: (message: string) => void;
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
  onSnapshotChange: (
    tabId: string,
    snapshot: BrowserTabSnapshot,
    options?: BrowserTabSnapshotOptions,
  ) => void;
}) {
  const {
    active,
    connectionUrl,
    designerModeActive = false,
    designerTool = "area-comment",
    onBrowserLoadError,
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
  const mountedRef = useRef(false);
  const pendingUrlRef = useRef<string | null>(null);
  const pendingSnapshotOptionsRef = useRef<BrowserTabSnapshotOptions | null>(null);
  const snapshotFlushTimerRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const designRequestPanelRef = useRef<HTMLFormElement | null>(null);
  const dragSelectionRef = useRef<ActiveDragSelection | null>(null);
  const designRequestPanelDragStateRef = useRef<{
    originLeft: number;
    originTop: number;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const designRequestPanelRequestIdRef = useRef<string | null>(null);
  const previousDesignRequestPanelLayoutRef = useRef<{
    panelSize: FloatingOverlaySize;
    viewport: OverlayViewportSize;
  } | null>(null);
  const elementHoverFrameRef = useRef<number | null>(null);
  const pendingElementHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const elementHoverRequestInFlightRef = useRef(false);
  const hoveredElementCaptureRef = useRef<BrowserPageElementCapture | null>(null);
  const hoveredElementPointRef = useRef<{ x: number; y: number } | null>(null);
  const latestElementHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const elementHoverRequestTokenRef = useRef(0);
  const annotationPointerRef = useRef<{
    color: string;
    pointerId: number;
    lastX: number;
    lastY: number;
    snapshot: ImageData | null;
    startX: number;
    startY: number;
    tool: AnnotationTool;
  } | null>(null);
  const requestedUrlRef = useRef(tab.url);
  const localConnectionUrl = useMemo(() => resolveLocalConnectionUrl(), []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [selectionRect, setSelectionRect] = useState<BrowserDesignSelectionRect | null>(null);
  const [hoveredElementCapture, setHoveredElementCapture] =
    useState<BrowserPageElementCapture | null>(null);
  const [designDraft, setDesignDraft] = useState<BrowserDesignCaptureDraft | null>(null);
  const [designInstructions, setDesignInstructions] = useState("");
  const [annotationColor, setAnnotationColor] = useState(DEFAULT_ANNOTATION_COLOR);
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>("pencil");
  const [hasAnnotationStrokes, setHasAnnotationStrokes] = useState(false);
  const [isSubmittingDesignRequest, setIsSubmittingDesignRequest] = useState(false);
  const [overlayViewportSize, setOverlayViewportSize] = useState<OverlayViewportSize | null>(null);
  const [designRequestPanelSize, setDesignRequestPanelSize] = useState<FloatingOverlaySize>(
    DEFAULT_DESIGN_REQUEST_PANEL_SIZE,
  );
  const [designRequestPanelPosition, setDesignRequestPanelPosition] =
    useState<DesignRequestPanelPosition | null>(null);
  const emitTabSnapshotChange = useEffectEvent(
    (snapshot: BrowserTabSnapshot, options?: BrowserTabSnapshotOptions) => {
      onSnapshotChange(tab.id, snapshot, options);
    },
  );
  const cancelDesignCaptureEvent = useEffectEvent(() => {
    onDesignCaptureCancel?.();
  });
  const reportBrowserLoadError = useEffectEvent((message: string) => {
    onBrowserLoadError?.(message);
  });
  const reportDesignCaptureError = useEffectEvent((message: string) => {
    onDesignCaptureError?.(message);
  });
  const requestContextMenuFallback = useEffectEvent(
    (position: { x: number; y: number }, requestedAt: number) => {
      onContextMenuFallbackRequest(tab.id, position, requestedAt);
    },
  );
  const commitHoveredElementCapture = useCallback(
    (capture: BrowserPageElementCapture | null, point: { x: number; y: number } | null) => {
      hoveredElementCaptureRef.current = capture;
      hoveredElementPointRef.current = point;
      setHoveredElementCapture((current) => {
        const currentRect = current?.targetRect;
        const nextRect = capture?.targetRect;
        const currentSelector = current?.target?.selector ?? null;
        const nextSelector = capture?.target?.selector ?? null;
        if (
          currentSelector === nextSelector &&
          currentRect?.x === nextRect?.x &&
          currentRect?.y === nextRect?.y &&
          currentRect?.width === nextRect?.width &&
          currentRect?.height === nextRect?.height
        ) {
          return current;
        }
        return capture;
      });
    },
    [],
  );
  const clearHoveredElementCapture = useCallback(() => {
    elementHoverRequestTokenRef.current += 1;
    latestElementHoverPointRef.current = null;
    pendingElementHoverPointRef.current = null;
    if (elementHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(elementHoverFrameRef.current);
      elementHoverFrameRef.current = null;
    }
    commitHoveredElementCapture(null, null);
  }, [commitHoveredElementCapture]);

  const resolveLoadUrl = useCallback(
    (url: string) =>
      resolveBrowserRelayUrl({
        url,
        ownerConnectionUrl: connectionUrl,
        localConnectionUrl,
      }),
    [connectionUrl, localConnectionUrl],
  );

  const resolveSnapshotUrl = useCallback((currentUrl: string) => {
    const displayUrl = resolveBrowserDisplayUrl(currentUrl);
    return normalizeBrowserHttpUrl(displayUrl) ?? requestedUrlRef.current;
  }, []);

  const emitSnapshotNow = useCallback(
    (options?: BrowserTabSnapshotOptions) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        return;
      }
      const resolvedUrl = resolveSnapshotUrl(webview.getURL());
      emitTabSnapshotChange(
        {
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward(),
          devToolsOpen: webview.isDevToolsOpened(),
          loading: webview.isLoading(),
          title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
          url: resolvedUrl,
        },
        options,
      );
    },
    [resolveSnapshotUrl],
  );

  const flushScheduledSnapshot = useCallback(() => {
    snapshotFlushTimerRef.current = null;
    const options = pendingSnapshotOptionsRef.current ?? undefined;
    pendingSnapshotOptionsRef.current = null;
    emitSnapshotNow(options);
  }, [emitSnapshotNow]);

  const scheduleEmitSnapshot = useCallback(
    (options: BrowserTabSnapshotOptions = {}) => {
      const pending = pendingSnapshotOptionsRef.current;
      pendingSnapshotOptionsRef.current = {
        persistTab: pending?.persistTab === true || options.persistTab === true,
        recordHistory: pending?.recordHistory === true || options.recordHistory === true,
      };
      if (snapshotFlushTimerRef.current !== null) {
        return;
      }
      snapshotFlushTimerRef.current = window.setTimeout(
        flushScheduledSnapshot,
        BROWSER_SNAPSHOT_COALESCE_MS,
      );
    },
    [flushScheduledSnapshot],
  );

  const cancelScheduledSnapshot = useCallback(() => {
    if (snapshotFlushTimerRef.current !== null) {
      window.clearTimeout(snapshotFlushTimerRef.current);
      snapshotFlushTimerRef.current = null;
    }
    pendingSnapshotOptionsRef.current = null;
  }, []);

  const navigate = useCallback(
    (url: string) => {
      requestedUrlRef.current = url;
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      const currentUrl = normalizeBrowserHttpUrl(resolveBrowserDisplayUrl(webview.getURL()));
      if (currentUrl === normalizeBrowserHttpUrl(url)) {
        scheduleEmitSnapshot({ persistTab: true });
        return;
      }

      loadWebviewUrl(webview, resolveLoadUrl(url), reportBrowserLoadError);
    },
    [resolveLoadUrl, scheduleEmitSnapshot],
  );

  const inspectBrowserPoint = useCallback(
    async (point: { x: number; y: number }): Promise<BrowserPageElementCapture | null> => {
      const webview = webviewRef.current;
      if (!activeRef.current || !webview || !readyRef.current || !webview.executeJavaScript) {
        return null;
      }
      const overlayHost = overlayRef.current ?? hostRef.current;
      const capture = await webview.executeJavaScript<BrowserPageElementCapture | null>(
        buildBrowserElementCaptureScript(
          point,
          overlayHost
            ? {
                width: overlayHost.clientWidth,
                height: overlayHost.clientHeight,
              }
            : undefined,
        ),
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

      const overlayHost = overlayRef.current ?? hostRef.current;
      const viewportWidth = Math.max(1, Math.round(overlayHost?.clientWidth ?? selection.width));
      const viewportHeight = Math.max(1, Math.round(overlayHost?.clientHeight ?? selection.height));
      const capturedImage = await webview.capturePage();
      const imageDataUrl = await cropCapturedImageDataUrl({
        dataUrl: capturedImage.toDataURL(),
        selection,
        viewportHeight,
        viewportWidth,
      });
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
      zoomIn: () => {
        if (!readyRef.current || !webviewRef.current) return;
        setWebviewZoomFactor(
          webviewRef.current,
          getWebviewZoomFactor(webviewRef.current) + BROWSER_ZOOM_STEP,
        );
      },
      zoomOut: () => {
        if (!readyRef.current || !webviewRef.current) return;
        setWebviewZoomFactor(
          webviewRef.current,
          getWebviewZoomFactor(webviewRef.current) - BROWSER_ZOOM_STEP,
        );
      },
      zoomReset: () => {
        if (!readyRef.current || !webviewRef.current) return;
        setWebviewZoomFactor(webviewRef.current, 1);
      },
    };
    onHandleChange(tab.id, handle);
    return () => {
      onHandleChange(tab.id, null);
    };
  }, [navigate, onHandleChange, tab.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webviewRef.current) return;

    const webview = document.createElement("webview") as BrowserWebview;
    webview.className = "size-full bg-background";
    webview.setAttribute("partition", IN_APP_BROWSER_PARTITION);
    webview.setAttribute("src", resolveLoadUrl(requestedUrlRef.current));

    const handleDomReady = () => {
      readyRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (
        pendingUrl &&
        normalizeBrowserHttpUrl(pendingUrl) !==
          normalizeBrowserHttpUrl(resolveBrowserDisplayUrl(webview.getURL()))
      ) {
        loadWebviewUrl(webview, resolveLoadUrl(pendingUrl), reportBrowserLoadError);
        return;
      }
      scheduleEmitSnapshot({ persistTab: true });
    };
    const handleLoadStart = () => {
      emitTabSnapshotChange(
        {
          canGoBack: readyRef.current ? webview.canGoBack() : false,
          canGoForward: readyRef.current ? webview.canGoForward() : false,
          devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
          loading: true,
          title: resolveBrowserTabTitle(requestedUrlRef.current),
          url: requestedUrlRef.current,
        },
        { persistTab: false },
      );
    };
    const handleNavigation = () => {
      scheduleEmitSnapshot({ persistTab: true });
    };
    const handleLoadStop = () => {
      scheduleEmitSnapshot({ persistTab: true, recordHistory: true });
    };
    const handleInPageNavigation = () => {
      scheduleEmitSnapshot({ persistTab: true, recordHistory: true });
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & { errorCode?: number };
      if (detail.errorCode === -3) {
        return;
      }
      cancelScheduledSnapshot();
      const resolvedUrl = resolveSnapshotUrl(webview.getURL());
      emitTabSnapshotChange(
        {
          canGoBack: readyRef.current ? webview.canGoBack() : false,
          canGoForward: readyRef.current ? webview.canGoForward() : false,
          devToolsOpen: readyRef.current ? webview.isDevToolsOpened() : false,
          loading: false,
          title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
          url: resolvedUrl,
        },
        { persistTab: true },
      );
    };
    const handleContextMenu = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      requestContextMenuFallback(
        { x: mouseEvent.clientX, y: mouseEvent.clientY },
        performance.now(),
      );
    };
    const handleRenderProcessGone = (event: Event) => {
      readyRef.current = false;
      cancelScheduledSnapshot();
      const detail = event as Event & { reason?: string };
      const reason = typeof detail.reason === "string" ? detail.reason : "unknown";
      reportBrowserLoadError(`Browser tab renderer stopped (${reason}).`);
      setSelectionRect(null);
      setHoveredElementCapture(null);
      hoveredElementCaptureRef.current = null;
      dragSelectionRef.current = null;
      annotationPointerRef.current = null;
      setDesignDraft(null);
      setDesignInstructions("");
      setHasAnnotationStrokes(false);
      setIsSubmittingDesignRequest(false);
      cancelDesignCaptureEvent();
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleLoadStop);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleInPageNavigation);
    webview.addEventListener("devtools-closed", handleNavigation);
    webview.addEventListener("devtools-opened", handleNavigation);
    webview.addEventListener("page-title-updated", handleNavigation);
    webview.addEventListener("did-fail-load", handleFailLoad);
    webview.addEventListener("contextmenu", handleContextMenu);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    host.replaceChildren(webview);
    webviewRef.current = webview;

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleLoadStop);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleInPageNavigation);
      webview.removeEventListener("devtools-closed", handleNavigation);
      webview.removeEventListener("devtools-opened", handleNavigation);
      webview.removeEventListener("page-title-updated", handleNavigation);
      webview.removeEventListener("did-fail-load", handleFailLoad);
      webview.removeEventListener("contextmenu", handleContextMenu);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
      stopWebviewBeforeRemoval(webview);
      host.replaceChildren();
      webviewRef.current = null;
      readyRef.current = false;
      cancelScheduledSnapshot();
    };
  }, [cancelScheduledSnapshot, resolveLoadUrl, resolveSnapshotUrl, scheduleEmitSnapshot]);

  useEffect(() => {
    navigate(tab.url);
  }, [navigate, tab.url]);

  const clearAnnotationCanvas = useCallback(() => {
    annotationPointerRef.current = null;
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
    designRequestPanelDragStateRef.current = null;
    designRequestPanelRequestIdRef.current = null;
    pendingElementHoverPointRef.current = null;
    setDesignDraft(null);
    setDesignInstructions("");
    setDesignRequestPanelPosition(null);
    clearAnnotationCanvas();
    setIsSubmittingDesignRequest(false);
    cancelDesignCaptureEvent();
  }, [clearAnnotationCanvas]);

  useEffect(() => {
    if (!active) {
      clearHoveredElementCapture();
    }
  }, [active, clearHoveredElementCapture]);

  useEffect(() => {
    if (!active || !designDraft) {
      return;
    }

    const onWindowKeyDownCapture = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancelDesignCapture();
    };

    window.addEventListener("keydown", onWindowKeyDownCapture, true);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDownCapture, true);
    };
  }, [active, cancelDesignCapture, designDraft]);

  useEffect(() => {
    if (designerModeActive) {
      return;
    }
    if (!designDraft) {
      setSelectionRect(null);
      clearHoveredElementCapture();
      dragSelectionRef.current = null;
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, clearHoveredElementCapture, designDraft, designerModeActive]);

  useEffect(() => {
    if (designerTool === "element-comment") {
      return;
    }
    clearHoveredElementCapture();
  }, [clearHoveredElementCapture, designerTool]);

  useEffect(() => {
    if (!designDraft || designDraft.tool === designerTool) {
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, designDraft, designerTool]);

  useEffect(() => {
    return () => {
      elementHoverRequestTokenRef.current += 1;
      if (elementHoverFrameRef.current !== null) {
        window.cancelAnimationFrame(elementHoverFrameRef.current);
      }
    };
  }, []);

  const forwardElementCommentWheelToWebview = useCallback(
    (input: { deltaX: number; deltaY: number; clientX: number; clientY: number }) => {
      const webview = webviewRef.current;
      if (!webview || !readyRef.current) {
        return;
      }
      const overlayBounds = overlayRef.current?.getBoundingClientRect();
      const x = overlayBounds
        ? Math.round(
            clampPoint(input.clientX - overlayBounds.left, 0, Math.max(0, overlayBounds.width - 1)),
          )
        : 0;
      const y = overlayBounds
        ? Math.round(
            clampPoint(input.clientY - overlayBounds.top, 0, Math.max(0, overlayBounds.height - 1)),
          )
        : 0;
      const forwardingMode = resolveElementCommentWheelForwardingMode({
        hasSendInputEvent: typeof webview.sendInputEvent === "function",
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
      });
      if (forwardingMode === "electron-input" && webview.sendInputEvent) {
        webview.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          canScroll: true,
        });
        return;
      }
      if (!webview.executeJavaScript) {
        return;
      }
      runAsyncTask(
        webview.executeJavaScript(
          buildElementCommentScrollScript({
            deltaX: input.deltaX,
            deltaY: input.deltaY,
            point: { x, y },
            ...(overlayBounds
              ? { overlayViewport: { width: overlayBounds.width, height: overlayBounds.height } }
              : {}),
          }),
          true,
        ),
        "Failed to forward element-comment scroll to the browser webview.",
      );
    },
    [],
  );

  const onCaptureOverlayWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!active || !designerModeActive || designerTool !== "element-comment" || designDraft) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const deltaMultiplier =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? (overlayRef.current?.clientHeight ?? 1)
            : 1;
      forwardElementCommentWheelToWebview({
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX * deltaMultiplier,
        deltaY: event.deltaY * deltaMultiplier,
      });
    },
    [active, designDraft, designerModeActive, designerTool, forwardElementCommentWheelToWebview],
  );

  const startCapturedDraft = useCallback(
    (
      selection: BrowserDesignSelectionRect,
      inspectedPoint?: BrowserPageElementCapture | null,
      failureMessage = "Could not capture the selected browser area.",
    ) => {
      elementHoverRequestTokenRef.current += 1;
      setSelectionRect(selection);
      const requestId = generateDesignRequestId();
      const host = overlayRef.current;
      const viewportWidth = host?.clientWidth ?? 0;
      const viewportHeight = host?.clientHeight ?? 0;
      void captureDesignSelection(selection, requestId, inspectedPoint)
        .then((capture) => {
          if (!mountedRef.current) {
            return;
          }
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
          if (!mountedRef.current) {
            return;
          }
          const message = error instanceof Error ? error.message : failureMessage;
          reportDesignCaptureError(message);
          cancelDesignCapture();
        });
    },
    [cancelDesignCapture, captureDesignSelection, clearAnnotationCanvas, designerTool],
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
      !shouldRunElementHoverInspection({
        active: activeRef.current,
        designerModeActive,
        designerTool,
        hasDesignDraft: designDraft !== null,
        requestInFlight: elementHoverRequestInFlightRef.current,
      })
    ) {
      return;
    }
    const point = pendingElementHoverPointRef.current;
    if (!point) {
      return;
    }
    pendingElementHoverPointRef.current = null;
    elementHoverRequestInFlightRef.current = true;
    const requestToken = ++elementHoverRequestTokenRef.current;
    void inspectBrowserPoint(point)
      .then((capture) => {
        const latestPoint = latestElementHoverPointRef.current;
        const hasNewerHoverPoint =
          latestPoint !== null &&
          (Math.abs(latestPoint.x - point.x) > 6 || Math.abs(latestPoint.y - point.y) > 6);
        if (
          !activeRef.current ||
          elementHoverRequestTokenRef.current !== requestToken ||
          hasNewerHoverPoint
        ) {
          return;
        }
        commitHoveredElementCapture(capture, point);
      })
      .finally(() => {
        elementHoverRequestInFlightRef.current = false;
        if (activeRef.current && pendingElementHoverPointRef.current) {
          elementHoverFrameRef.current = window.requestAnimationFrame(
            flushHoveredElementInspection,
          );
        }
      });
  }, [
    commitHoveredElementCapture,
    designDraft,
    designerModeActive,
    designerTool,
    inspectBrowserPoint,
  ]);

  const onCaptureOverlayPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active || !designerModeActive || designDraft || event.button !== 0) {
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
        latestElementHoverPointRef.current = { x: startX, y: startY };
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
      active,
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
      if (!active || !designerModeActive || designerTool !== "element-comment" || designDraft) {
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
      latestElementHoverPointRef.current = point;
      pendingElementHoverPointRef.current = point;
      if (elementHoverFrameRef.current === null) {
        elementHoverFrameRef.current = window.requestAnimationFrame(flushHoveredElementInspection);
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [active, designDraft, designerModeActive, designerTool, flushHoveredElementInspection],
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
        if (!hasMinimumSelectionSize(finalSelection)) {
          setSelectionRect(null);
          return;
        }
        startCapturedDraft(finalSelection);
        return;
      }

      if (
        !active ||
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
      latestElementHoverPointRef.current = point;
      event.preventDefault();
      event.stopPropagation();
      const hoveredCapture = hoveredElementCaptureRef.current;
      const stableCapture =
        hoveredCapture && isPointInsideSelectionRect(point, hoveredCapture.targetRect)
          ? hoveredCapture
          : null;
      const capturePromise = stableCapture
        ? Promise.resolve(stableCapture)
        : inspectBrowserPoint(point);
      void capturePromise
        .then((capture) => {
          if (!activeRef.current) {
            return;
          }
          const selection = capture?.targetRect ?? null;
          if (!hasMinimumSelectionSize(selection, MIN_ELEMENT_CAPTURE_SIZE_PX)) {
            throw new Error("Click a visible page element to leave a comment.");
          }
          commitHoveredElementCapture(capture, point);
          startCapturedDraft(selection, capture, "Could not capture the selected page element.");
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Could not capture the selected page element.";
          reportDesignCaptureError(message);
        });
    },
    [
      active,
      designDraft,
      designerModeActive,
      designerTool,
      inspectBrowserPoint,
      selectionRect,
      startCapturedDraft,
      commitHoveredElementCapture,
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
    const trimmedInstructions = normalizeDesignCommentToSingleLine(designInstructions).trim();
    const allowsEmptyComment = designDraft.tool === "draw-comment" && hasAnnotationStrokes;
    if (trimmedInstructions.length === 0 && !allowsEmptyComment) {
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
      reportDesignCaptureError(message);
    } finally {
      setIsSubmittingDesignRequest(false);
    }
  }, [
    buildAnnotatedPreviewCapture,
    cancelDesignCapture,
    designDraft,
    designInstructions,
    hasAnnotationStrokes,
    isSubmittingDesignRequest,
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
  useEffect(() => {
    if (!designDraft) {
      setOverlayViewportSize(null);
      return;
    }
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    const syncOverlayViewportSize = () => {
      const nextSize = {
        width: Math.max(1, Math.round(overlay.clientWidth)),
        height: Math.max(1, Math.round(overlay.clientHeight)),
      };
      setOverlayViewportSize((current) => {
        if (current?.width === nextSize.width && current?.height === nextSize.height) {
          return current;
        }
        return nextSize;
      });
    };
    syncOverlayViewportSize();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncOverlayViewportSize();
          })
        : null;
    observer?.observe(overlay);
    return () => {
      observer?.disconnect();
    };
  }, [designDraft]);
  useEffect(() => {
    if (!designDraft) {
      setDesignRequestPanelSize(DEFAULT_DESIGN_REQUEST_PANEL_SIZE);
      previousDesignRequestPanelLayoutRef.current = null;
      return;
    }
    const panel = designRequestPanelRef.current;
    if (!panel) {
      return;
    }
    const syncDesignRequestPanelSize = () => {
      const nextSize = {
        width: Math.max(1, Math.round(panel.offsetWidth)),
        height: Math.max(1, Math.round(panel.offsetHeight)),
      };
      setDesignRequestPanelSize((current) => {
        if (current.width === nextSize.width && current.height === nextSize.height) {
          return current;
        }
        return nextSize;
      });
    };
    syncDesignRequestPanelSize();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            syncDesignRequestPanelSize();
          })
        : null;
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
    };
  }, [designDraft]);

  const drawAnnotationStroke = useCallback(
    (
      context: CanvasRenderingContext2D,
      from: { x: number; y: number },
      to: { x: number; y: number },
      options: { color: string; tool: AnnotationTool },
    ) => {
      context.save();
      context.globalCompositeOperation =
        options.tool === "eraser" ? "destination-out" : "source-over";
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = options.tool === "eraser" ? 18 : 3.5;
      context.strokeStyle = options.color;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.restore();
      setHasAnnotationStrokes(true);
    },
    [],
  );

  const drawAnnotationShape = useCallback(
    (
      context: CanvasRenderingContext2D,
      start: { x: number; y: number },
      end: { x: number; y: number },
      options: {
        color: string;
        preview?: boolean;
        tool: Extract<AnnotationTool, "ellipse" | "line" | "rectangle">;
      },
    ) => {
      context.save();
      context.globalCompositeOperation = "source-over";
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 3;
      context.strokeStyle = options.color;
      if (options.tool === "line") {
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      } else if (options.tool === "rectangle") {
        context.strokeRect(
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y),
        );
      } else {
        context.beginPath();
        context.ellipse(
          (start.x + end.x) / 2,
          (start.y + end.y) / 2,
          Math.abs(end.x - start.x) / 2,
          Math.abs(end.y - start.y) / 2,
          0,
          0,
          Math.PI * 2,
        );
        context.stroke();
      }
      context.restore();
      if (!options.preview) {
        setHasAnnotationStrokes(true);
      }
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
      const canvas = annotationCanvasRef.current;
      const context = canvas?.getContext("2d");
      const point = resolveAnnotationPoint(event);
      const bounds = resolveAnnotationBounds(designDraft, canvas);
      if (!point || !context || !isPointInsideSelectionRect(point, bounds)) {
        return;
      }
      const clampedPoint = {
        x: clampPoint(point.x, bounds.x, bounds.x + bounds.width),
        y: clampPoint(point.y, bounds.y, bounds.y + bounds.height),
      };
      const snapshot =
        annotationTool === "pencil" || annotationTool === "eraser"
          ? null
          : context.getImageData(0, 0, canvas?.width ?? 0, canvas?.height ?? 0);
      annotationPointerRef.current = {
        color: annotationColor,
        pointerId: event.pointerId,
        lastX: clampedPoint.x,
        lastY: clampedPoint.y,
        snapshot,
        startX: clampedPoint.x,
        startY: clampedPoint.y,
        tool: annotationTool,
      };
      if (annotationTool === "pencil" || annotationTool === "eraser") {
        drawAnnotationStroke(context, clampedPoint, clampedPoint, {
          color: annotationColor,
          tool: annotationTool,
        });
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [annotationColor, annotationTool, designDraft, drawAnnotationStroke, resolveAnnotationPoint],
  );

  const handleAnnotationPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drawingState = annotationPointerRef.current;
      if (!drawingState || drawingState.pointerId !== event.pointerId || !designDraft) {
        return;
      }
      const canvas = annotationCanvasRef.current;
      const context = canvas?.getContext("2d");
      const point = resolveAnnotationPoint(event);
      if (!point || !canvas || !context) {
        return;
      }
      const bounds = resolveAnnotationBounds(designDraft, canvas);
      const nextPoint = {
        x: clampPoint(point.x, bounds.x, bounds.x + bounds.width),
        y: clampPoint(point.y, bounds.y, bounds.y + bounds.height),
      };
      if (drawingState.tool === "pencil" || drawingState.tool === "eraser") {
        drawAnnotationStroke(context, { x: drawingState.lastX, y: drawingState.lastY }, nextPoint, {
          color: drawingState.color,
          tool: drawingState.tool,
        });
      } else if (drawingState.snapshot) {
        context.putImageData(drawingState.snapshot, 0, 0);
        drawAnnotationShape(
          context,
          { x: drawingState.startX, y: drawingState.startY },
          nextPoint,
          {
            color: drawingState.color,
            preview: true,
            tool: drawingState.tool,
          },
        );
      }
      annotationPointerRef.current = {
        ...drawingState,
        lastX: nextPoint.x,
        lastY: nextPoint.y,
      };
      event.preventDefault();
    },
    [designDraft, drawAnnotationShape, drawAnnotationStroke, resolveAnnotationPoint],
  );

  const handleAnnotationPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drawingState = annotationPointerRef.current;
      if (!drawingState || drawingState.pointerId !== event.pointerId) {
        return;
      }
      const canvas = annotationCanvasRef.current;
      const context = canvas?.getContext("2d");
      if (
        canvas &&
        context &&
        drawingState.snapshot &&
        drawingState.tool !== "pencil" &&
        drawingState.tool !== "eraser"
      ) {
        context.putImageData(drawingState.snapshot, 0, 0);
        drawAnnotationShape(
          context,
          { x: drawingState.startX, y: drawingState.startY },
          { x: drawingState.lastX, y: drawingState.lastY },
          {
            color: drawingState.color,
            tool: drawingState.tool,
          },
        );
      }
      annotationPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [drawAnnotationShape],
  );

  const designRequestPanelViewport = useMemo<OverlayViewportSize | null>(() => {
    if (!designDraft) {
      return null;
    }
    return (
      overlayViewportSize ?? {
        width: designDraft.viewportWidth,
        height: designDraft.viewportHeight,
      }
    );
  }, [designDraft, overlayViewportSize]);
  const defaultDesignRequestPanelPosition = useMemo<DesignRequestPanelPosition | null>(() => {
    if (!designDraft) {
      return null;
    }
    const viewport = designRequestPanelViewport;
    if (!viewport) {
      return null;
    }
    return resolveDefaultDesignRequestPanelPosition(designDraft, viewport, designRequestPanelSize);
  }, [designDraft, designRequestPanelSize, designRequestPanelViewport]);
  useEffect(() => {
    if (!designDraft || !defaultDesignRequestPanelPosition) {
      designRequestPanelRequestIdRef.current = null;
      setDesignRequestPanelPosition(null);
      return;
    }
    if (designRequestPanelRequestIdRef.current === designDraft.capture.requestId) {
      return;
    }
    designRequestPanelRequestIdRef.current = designDraft.capture.requestId;
    previousDesignRequestPanelLayoutRef.current = null;
    setDesignRequestPanelPosition(defaultDesignRequestPanelPosition);
  }, [defaultDesignRequestPanelPosition, designDraft]);
  useEffect(() => {
    if (!designRequestPanelPosition || !designRequestPanelViewport) {
      previousDesignRequestPanelLayoutRef.current = null;
      return;
    }
    const previousLayout = previousDesignRequestPanelLayoutRef.current;
    previousDesignRequestPanelLayoutRef.current = {
      panelSize: designRequestPanelSize,
      viewport: designRequestPanelViewport,
    };
    const clampedPosition =
      previousLayout &&
      (previousLayout.viewport.width !== designRequestPanelViewport.width ||
        previousLayout.viewport.height !== designRequestPanelViewport.height ||
        previousLayout.panelSize.width !== designRequestPanelSize.width ||
        previousLayout.panelSize.height !== designRequestPanelSize.height)
        ? resolveAnchoredDesignRequestPanelPosition(
            designRequestPanelPosition,
            previousLayout.viewport,
            designRequestPanelViewport,
            previousLayout.panelSize,
            designRequestPanelSize,
          )
        : clampDesignRequestPanelPosition(
            designRequestPanelPosition,
            designRequestPanelViewport,
            designRequestPanelSize,
          );
    if (
      clampedPosition.left === designRequestPanelPosition.left &&
      clampedPosition.top === designRequestPanelPosition.top
    ) {
      return;
    }
    setDesignRequestPanelPosition(clampedPosition);
  }, [designRequestPanelPosition, designRequestPanelSize, designRequestPanelViewport]);
  const handleDesignRequestPanelPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const currentPosition = designRequestPanelPosition ?? defaultDesignRequestPanelPosition;
      if (!currentPosition) {
        return;
      }
      designRequestPanelDragStateRef.current = {
        originLeft: currentPosition.left,
        originTop: currentPosition.top,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [defaultDesignRequestPanelPosition, designRequestPanelPosition],
  );
  const handleDesignRequestPanelPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = designRequestPanelDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId || !designRequestPanelViewport) {
        return;
      }
      setDesignRequestPanelPosition(
        clampDesignRequestPanelPosition(
          {
            left: dragState.originLeft + (event.clientX - dragState.startX),
            top: dragState.originTop + (event.clientY - dragState.startY),
          },
          designRequestPanelViewport,
          designRequestPanelSize,
        ),
      );
      event.preventDefault();
      event.stopPropagation();
    },
    [designRequestPanelSize, designRequestPanelViewport],
  );
  const handleDesignRequestPanelPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = designRequestPanelDragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      designRequestPanelDragStateRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  useEffect(() => {
    const resetPointerInteractions = () => {
      const overlay = overlayRef.current;
      const dragSelection = dragSelectionRef.current;
      if (overlay && dragSelection && overlay.hasPointerCapture(dragSelection.pointerId)) {
        overlay.releasePointerCapture(dragSelection.pointerId);
      }
      dragSelectionRef.current = null;
      setSelectionRect(null);

      const annotationCanvas = annotationCanvasRef.current;
      const annotationState = annotationPointerRef.current;
      if (
        annotationCanvas &&
        annotationState &&
        annotationCanvas.hasPointerCapture(annotationState.pointerId)
      ) {
        annotationCanvas.releasePointerCapture(annotationState.pointerId);
      }
      annotationPointerRef.current = null;

      const designRequestPanel = designRequestPanelRef.current;
      const panelDragState = designRequestPanelDragStateRef.current;
      if (
        designRequestPanel &&
        panelDragState &&
        designRequestPanel.hasPointerCapture(panelDragState.pointerId)
      ) {
        designRequestPanel.releasePointerCapture(panelDragState.pointerId);
      }
      designRequestPanelDragStateRef.current = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        resetPointerInteractions();
      }
    };
    window.addEventListener("blur", resetPointerInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetPointerInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
  const designRequestPanelStyle = useMemo<CSSProperties | undefined>(() => {
    const position = designRequestPanelPosition ?? defaultDesignRequestPanelPosition;
    if (!position || !designRequestPanelViewport) {
      return undefined;
    }
    return {
      ...position,
      maxWidth: `${Math.max(160, designRequestPanelViewport.width - DESIGN_REQUEST_PANEL_MARGIN_PX * 2)}px`,
    };
  }, [defaultDesignRequestPanelPosition, designRequestPanelPosition, designRequestPanelViewport]);
  const activeOverlaySelection =
    designerTool === "draw-comment" || designDraft?.tool === "draw-comment"
      ? null
      : (selectionRect ??
        (designerTool === "element-comment" ? (hoveredElementCapture?.targetRect ?? null) : null));
  const canSubmitDesignDraft = designDraft
    ? designInstructions.trim().length > 0 ||
      (designDraft.tool === "draw-comment" && hasAnnotationStrokes)
    : false;

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
          onWheel={onCaptureOverlayWheel}
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
              className="pointer-events-none absolute"
              style={{
                left: `${activeOverlaySelection.x}px`,
                top: `${activeOverlaySelection.y}px`,
                width: `${activeOverlaySelection.width}px`,
                height: `${activeOverlaySelection.height}px`,
              }}
            >
              <div className="absolute inset-0 border border-primary/75 bg-primary/[0.06] " />
            </div>
          )}
          {designDraft && designRequestPanelStyle && (
            <form
              ref={designRequestPanelRef}
              className="absolute z-30 w-[272px] max-w-[calc(100%-16px)] rounded-2xl border border-border/60 bg-background/95 p-2.5  backdrop-blur-xl"
              style={designRequestPanelStyle}
              onSubmit={(event) => {
                event.preventDefault();
                void submitDesignDraft();
              }}
            >
              <div
                className="mb-2 flex h-5 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
                onPointerDown={handleDesignRequestPanelPointerDown}
                onPointerMove={handleDesignRequestPanelPointerMove}
                onPointerUp={handleDesignRequestPanelPointerEnd}
                onPointerCancel={handleDesignRequestPanelPointerEnd}
              >
                <div className="h-1 w-10 rounded-full bg-border/70" />
              </div>
              {designDraft.tool === "draw-comment" ? (
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-background/88 p-1">
                    {DRAW_TOOL_OPTIONS.map(({ label, tool }) => (
                      <button
                        key={tool}
                        type="button"
                        onClick={() => {
                          setAnnotationTool(tool);
                        }}
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-lg transition-colors",
                          annotationTool === tool
                            ? "bg-primary/14 text-primary"
                            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                        )}
                        aria-label={label}
                        title={label}
                      >
                        <DrawingToolIcon tool={tool} className="size-3.5" />
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-background/88 p-1">
                    {DRAW_COLOR_SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => {
                          setAnnotationColor(color);
                        }}
                        className={cn(
                          "inline-flex size-6 items-center justify-center rounded-full border transition-transform",
                          annotationColor === color
                            ? "scale-105 border-white/60"
                            : "border-transparent hover:scale-105",
                        )}
                        aria-label={`Select ${color} drawing color`}
                        title="Select drawing color"
                      >
                        <span
                          className="size-3 rounded-full border border-black/15"
                          style={{ backgroundColor: color }}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex h-10 items-center rounded-[var(--control-radius)] border border-border/60 bg-background/92">
                <button
                  type="button"
                  onClick={cancelDesignCapture}
                  className="inline-flex h-full w-10 shrink-0 items-center justify-center border-r border-border/60 text-muted-foreground transition-colors hover:text-foreground"
                  disabled={isSubmittingDesignRequest}
                  aria-label="Cancel comment"
                  title="Cancel comment"
                >
                  <XIcon className="size-3.5" />
                </button>
                <input
                  value={designInstructions}
                  onChange={(event) =>
                    setDesignInstructions(normalizeDesignCommentToSingleLine(event.target.value))
                  }
                  placeholder="Comment for the agent"
                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] outline-none placeholder:text-muted-foreground/55"
                  autoFocus
                />
                <button
                  type="submit"
                  className="inline-flex h-full w-10 shrink-0 items-center justify-center border-l border-border/60 text-primary transition-colors hover:text-primary/85 disabled:opacity-40"
                  disabled={isSubmittingDesignRequest || !canSubmitDesignDraft}
                  aria-label="Submit comment"
                  title="Submit comment"
                >
                  <ArrowUpRightIcon className="size-3.5" />
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
