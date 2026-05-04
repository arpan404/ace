import { ArrowUpRightIcon, GlobeIcon, MousePointer2Icon } from "lucide-react";
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
  type BrowserAgentPointerEffect,
  type BrowserAgentPointerPoint,
  type BrowserDesignCaptureResult,
  type BrowserDesignCaptureSubmission,
  type BrowserDesignElementDescriptor,
  type BrowserDesignSelectionRect,
  type BrowserConsoleLogEntry,
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

function normalizeConsoleLogLevel(value: unknown): BrowserConsoleLogEntry["level"] {
  if (typeof value === "string") {
    switch (value.toLowerCase()) {
      case "debug":
      case "info":
      case "log":
      case "warn":
      case "error":
        return value.toLowerCase() as BrowserConsoleLogEntry["level"];
      case "warning":
        return "warn";
      default:
        return "log";
    }
  }
  if (typeof value === "number") {
    return value >= 2 ? "error" : "log";
  }
  return "log";
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

interface AgentBrowserPointerState {
  key: number;
  mode: BrowserAgentPointerEffect["type"];
  pressed: boolean;
  scrollX: number;
  scrollY: number;
  visible: boolean;
  x: number;
  y: number;
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

interface PendingElementCommentWheel {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
}

const MIN_CAPTURE_SIZE_PX = 24;
const MIN_ELEMENT_CAPTURE_SIZE_PX = 8;
const DESIGN_REQUEST_PANEL_WIDTH_PX = 360;
const DESIGN_REQUEST_PANEL_HEIGHT_PX = 56;
const DESIGN_REQUEST_PANEL_MARGIN_PX = 8;
const BROWSER_SNAPSHOT_COALESCE_MS = 150;
const ELEMENT_HOVER_INSPECTION_SCROLL_PAUSE_MS = 120;
const DEFAULT_DESIGN_REQUEST_PANEL_SIZE: FloatingOverlaySize = {
  width: DESIGN_REQUEST_PANEL_WIDTH_PX,
  height: DESIGN_REQUEST_PANEL_HEIGHT_PX,
};
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

async function normalizeVisibleBrowserScreenshotDataUrl(input: {
  dataUrl: string;
  viewportWidth: number;
  viewportHeight: number;
}): Promise<string> {
  const image = await loadImageDataUrl(input.dataUrl);
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const viewportWidth = Math.max(1, Math.round(input.viewportWidth));
  const viewportHeight = Math.max(1, Math.round(input.viewportHeight));
  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    (imageWidth === viewportWidth && imageHeight === viewportHeight)
  ) {
    return input.dataUrl;
  }

  const canvas = document.createElement("canvas");
  canvas.width = viewportWidth;
  canvas.height = viewportHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    return input.dataUrl;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, viewportWidth, viewportHeight);
  return canvas.toDataURL(resolveDataUrlMimeType(input.dataUrl));
}

function waitForBrowserPointerFrame(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function easeBrowserPointerMovement(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function readBrowserPointerDistance(
  start: BrowserAgentPointerPoint,
  end: BrowserAgentPointerPoint,
): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function resolveBrowserPointerMovementDuration(
  start: BrowserAgentPointerPoint,
  end: BrowserAgentPointerPoint,
  multiplier = 1,
): number {
  const distance = readBrowserPointerDistance(start, end);
  return Math.round(Math.max(160, Math.min(720, (150 + Math.sqrt(distance) * 24) * multiplier)));
}

function resolveBrowserPointerCurvePoint(
  start: BrowserAgentPointerPoint,
  end: BrowserAgentPointerPoint,
  progress: number,
  curveSeed: number,
): BrowserAgentPointerPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(92, Math.max(12, distance * 0.18));
  const direction = curveSeed % 2 === 0 ? 1 : -1;
  const control = {
    x: start.x + dx * 0.5 + (-dy / distance) * bend * direction,
    y: start.y + dy * 0.5 + (dx / distance) * bend * direction,
  };
  const inverse = 1 - progress;
  return {
    x:
      inverse * inverse * start.x +
      2 * inverse * progress * control.x +
      progress * progress * end.x,
    y:
      inverse * inverse * start.y +
      2 * inverse * progress * control.y +
      progress * progress * end.y,
  };
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
      target.scrollBy({ left: delta.left, top: delta.top });
      return;
    }
    target = target.parentElement;
  }
  window.scrollBy({
    left: delta.left,
    top: delta.top,
  });
})();`;
}

function generateDesignRequestId(): string {
  return `DR-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function BrowserDesignSelectionBox(props: { rect: BrowserDesignSelectionRect }) {
  const { rect } = props;
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      <div
        className={cn(
          "absolute -inset-0.5 rounded-[5px] bg-primary/[0.055]",
          "shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_14%,transparent)]",
        )}
      />
      <div
        className={cn(
          "absolute inset-0 rounded-[4px]",
          "outline outline-2 -outline-offset-1 outline-primary/95",
          "drop-shadow-[0_1px_1px_color-mix(in_srgb,var(--background)_54%,transparent)]",
        )}
      />
    </div>
  );
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
  const consoleLogsRef = useRef<BrowserConsoleLogEntry[]>([]);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const designRequestPanelRef = useRef<HTMLFormElement | null>(null);
  const dragSelectionRef = useRef<ActiveDragSelection | null>(null);
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
  const elementCommentWheelFrameRef = useRef<number | null>(null);
  const lastElementCommentWheelAtRef = useRef(0);
  const pendingElementCommentWheelRef = useRef<PendingElementCommentWheel | null>(null);
  const agentPointerTokenRef = useRef(0);
  const agentPointerActionTimerRef = useRef<number | null>(null);
  const agentPointerFrameRef = useRef<number | null>(null);
  const agentPointerPositionRef = useRef<BrowserAgentPointerPoint | null>(null);
  const requestedUrlRef = useRef(tab.url);
  const localConnectionUrl = useMemo(() => resolveLocalConnectionUrl(), []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [selectionRect, setSelectionRect] = useState<BrowserDesignSelectionRect | null>(null);
  const [hoveredElementCapture, setHoveredElementCapture] =
    useState<BrowserPageElementCapture | null>(null);
  const [designDraft, setDesignDraft] = useState<BrowserDesignCaptureDraft | null>(null);
  const [designInstructions, setDesignInstructions] = useState("");
  const [isSubmittingDesignRequest, setIsSubmittingDesignRequest] = useState(false);
  const [overlayViewportSize, setOverlayViewportSize] = useState<OverlayViewportSize | null>(null);
  const [agentPointer, setAgentPointer] = useState<AgentBrowserPointerState | null>(null);
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

  const readSnapshot = useCallback((): BrowserTabSnapshot | null => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return null;
    }
    const resolvedUrl = resolveSnapshotUrl(webview.getURL());
    return {
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward(),
      devToolsOpen: webview.isDevToolsOpened(),
      loading: webview.isLoading(),
      title: resolveBrowserTabTitle(resolvedUrl, webview.getTitle()),
      url: resolvedUrl,
    };
  }, [resolveSnapshotUrl]);

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

  const clearAgentPointerActionTimer = useCallback(() => {
    if (agentPointerActionTimerRef.current === null) {
      return;
    }
    window.clearTimeout(agentPointerActionTimerRef.current);
    agentPointerActionTimerRef.current = null;
  }, []);

  const cancelAgentPointerAnimation = useCallback(() => {
    if (agentPointerFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(agentPointerFrameRef.current);
    agentPointerFrameRef.current = null;
  }, []);

  const resolveAgentPointerViewport = useCallback(() => {
    const host = overlayRef.current ?? hostRef.current;
    return {
      height: Math.max(1, Math.round(host?.clientHeight ?? 1)),
      width: Math.max(1, Math.round(host?.clientWidth ?? 1)),
    };
  }, []);

  const clampAgentPointerPoint = useCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      const viewport = resolveAgentPointerViewport();
      return {
        x: Math.max(0, Math.min(viewport.width, Math.round(point.x))),
        y: Math.max(0, Math.min(viewport.height, Math.round(point.y))),
      };
    },
    [resolveAgentPointerViewport],
  );

  const resolveAgentPointerPoint = useCallback(
    (effect: BrowserAgentPointerEffect): { x: number; y: number } => {
      const pathEnd = effect.path?.at(-1);
      if (pathEnd && Number.isFinite(pathEnd.x) && Number.isFinite(pathEnd.y)) {
        return clampAgentPointerPoint(pathEnd);
      }
      if (effect.targetRect) {
        return clampAgentPointerPoint({
          x: effect.targetRect.x + effect.targetRect.width / 2,
          y: effect.targetRect.y + effect.targetRect.height / 2,
        });
      }
      const effectX = effect.x;
      const effectY = effect.y;
      if (
        typeof effectX === "number" &&
        Number.isFinite(effectX) &&
        typeof effectY === "number" &&
        Number.isFinite(effectY)
      ) {
        return clampAgentPointerPoint({ x: effectX, y: effectY });
      }
      if (agentPointerPositionRef.current) {
        return clampAgentPointerPoint(agentPointerPositionRef.current);
      }
      const viewport = resolveAgentPointerViewport();
      return {
        x: Math.round(viewport.width / 2),
        y: Math.round(viewport.height / 2),
      };
    },
    [clampAgentPointerPoint, resolveAgentPointerViewport],
  );

  const setAgentPointerFrame = useCallback(
    (
      effect: BrowserAgentPointerEffect,
      point: { x: number; y: number },
      options?: { pressed?: boolean | undefined },
    ) => {
      const key = agentPointerTokenRef.current;
      const nextPoint = clampAgentPointerPoint(point);
      agentPointerPositionRef.current = nextPoint;
      setAgentPointer({
        key,
        mode: effect.type,
        pressed: options?.pressed === true,
        scrollX: effect.scrollX ?? 0,
        scrollY: effect.scrollY ?? 0,
        visible: true,
        ...nextPoint,
      });
    },
    [clampAgentPointerPoint],
  );

  const scheduleAgentPointerRest = useCallback(
    (token: number, delayMs: number) => {
      clearAgentPointerActionTimer();
      agentPointerActionTimerRef.current = window.setTimeout(() => {
        agentPointerActionTimerRef.current = null;
        if (agentPointerTokenRef.current === token) {
          setAgentPointer((current) =>
            current
              ? {
                  ...current,
                  mode: "move",
                  pressed: false,
                  scrollX: 0,
                  scrollY: 0,
                  visible: true,
                }
              : current,
          );
        }
      }, delayMs);
    },
    [clearAgentPointerActionTimer],
  );

  const animateAgentPointerTo = useCallback(
    (
      effect: BrowserAgentPointerEffect,
      point: BrowserAgentPointerPoint,
      options?: {
        durationMultiplier?: number;
        pressed?: boolean | undefined;
        token: number;
      },
    ): Promise<void> => {
      const target = clampAgentPointerPoint(point);
      const start =
        agentPointerPositionRef.current ??
        clampAgentPointerPoint({
          x: target.x - 28,
          y: target.y + 24,
        });
      const distance = readBrowserPointerDistance(start, target);
      if (distance < 2) {
        setAgentPointerFrame(effect, target, { pressed: options?.pressed });
        return Promise.resolve();
      }

      const token = options?.token ?? agentPointerTokenRef.current;
      const startedAt = performance.now();
      const duration = resolveBrowserPointerMovementDuration(
        start,
        target,
        options?.durationMultiplier,
      );
      const curveSeed = token + Math.round(start.x * 0.13 + target.y * 0.17);

      cancelAgentPointerAnimation();
      return new Promise((resolve) => {
        const step = (timestamp: number) => {
          if (agentPointerTokenRef.current !== token) {
            resolve();
            return;
          }
          const progress = easeBrowserPointerMovement((timestamp - startedAt) / duration);
          const current = resolveBrowserPointerCurvePoint(start, target, progress, curveSeed);
          setAgentPointerFrame(effect, current, { pressed: options?.pressed });
          if (progress >= 1) {
            agentPointerFrameRef.current = null;
            setAgentPointerFrame(effect, target, { pressed: options?.pressed });
            resolve();
            return;
          }
          agentPointerFrameRef.current = window.requestAnimationFrame(step);
        };
        agentPointerFrameRef.current = window.requestAnimationFrame(step);
      });
    },
    [cancelAgentPointerAnimation, clampAgentPointerPoint, setAgentPointerFrame],
  );

  const animateAgentPointer = useCallback(
    async (effect: BrowserAgentPointerEffect): Promise<void> => {
      if (!activeRef.current) {
        return;
      }
      const token = agentPointerTokenRef.current + 1;
      agentPointerTokenRef.current = token;
      clearAgentPointerActionTimer();

      const path = effect.path
        ?.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map(clampAgentPointerPoint);

      if (effect.type === "drag" && path && path.length >= 2) {
        await animateAgentPointerTo(effect, path[0]!, {
          durationMultiplier: 0.82,
          pressed: false,
          token,
        });
        if (agentPointerTokenRef.current !== token) {
          return;
        }
        setAgentPointerFrame(effect, path[0]!, { pressed: true });
        await waitForBrowserPointerFrame(80);
        if (agentPointerTokenRef.current !== token) {
          return;
        }
        const dragMovement = (async () => {
          const steps = path.slice(1);
          for (const point of steps) {
            if (agentPointerTokenRef.current !== token) {
              return;
            }
            await animateAgentPointerTo(effect, point, {
              durationMultiplier: 0.62,
              pressed: true,
              token,
            });
          }
        })();
        await dragMovement;
        if (agentPointerTokenRef.current !== token) {
          return;
        }
        setAgentPointerFrame(effect, path[path.length - 1]!, { pressed: false });
        scheduleAgentPointerRest(token, 260);
        return;
      }

      const point = resolveAgentPointerPoint(effect);
      await animateAgentPointerTo(effect, point, {
        durationMultiplier: effect.type === "scroll" ? 0.78 : 1,
        pressed: false,
        token,
      });
      if (agentPointerTokenRef.current !== token) {
        return;
      }
      if (effect.type === "click" || effect.type === "double_click") {
        setAgentPointerFrame(effect, point, { pressed: true });
        await waitForBrowserPointerFrame(effect.type === "double_click" ? 90 : 80);
        if (agentPointerTokenRef.current !== token) {
          return;
        }
        setAgentPointerFrame(effect, point, { pressed: false });
        if (effect.type === "double_click") {
          await waitForBrowserPointerFrame(80);
          if (agentPointerTokenRef.current !== token) {
            return;
          }
          setAgentPointerFrame(effect, point, { pressed: true });
          await waitForBrowserPointerFrame(80);
          if (agentPointerTokenRef.current !== token) {
            return;
          }
          setAgentPointerFrame(effect, point, { pressed: false });
        }
        scheduleAgentPointerRest(token, 220);
        return;
      }
      scheduleAgentPointerRest(token, effect.type === "scroll" ? 620 : 180);
    },
    [
      animateAgentPointerTo,
      clampAgentPointerPoint,
      clearAgentPointerActionTimer,
      resolveAgentPointerPoint,
      scheduleAgentPointerRest,
      setAgentPointerFrame,
    ],
  );

  useEffect(() => {
    const handle: BrowserTabHandle = {
      animateAgentPointer,
      captureVisiblePage: async () => {
        const webview = webviewRef.current;
        if (!readyRef.current || !webview?.capturePage) {
          throw new Error("The browser tab cannot capture a screenshot yet.");
        }
        const image = await webview.capturePage();
        const overlayHost = overlayRef.current ?? hostRef.current;
        const viewportWidth = overlayHost?.clientWidth ?? webview.clientWidth;
        const viewportHeight = overlayHost?.clientHeight ?? webview.clientHeight;
        return normalizeVisibleBrowserScreenshotDataUrl({
          dataUrl: image.toDataURL(),
          viewportHeight,
          viewportWidth,
        });
      },
      closeDevTools: () => {
        if (!readyRef.current || !webviewRef.current?.isDevToolsOpened()) return;
        webviewRef.current.closeDevTools();
      },
      executeJavaScript: async <T = unknown>(code: string): Promise<T> => {
        const webview = webviewRef.current;
        if (!readyRef.current || !webview?.executeJavaScript) {
          throw new Error("The browser tab cannot execute JavaScript yet.");
        }
        return webview.executeJavaScript<T>(code, true);
      },
      getZoomFactor: () => {
        if (!readyRef.current || !webviewRef.current) return 1;
        return getWebviewZoomFactor(webviewRef.current);
      },
      getSnapshot: () => readSnapshot(),
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
      readConsoleLogs: (options) => {
        const levels = new Set(
          options?.levels?.map((level) => (level === "warning" ? "warn" : level)) ?? [],
        );
        const filter = options?.filter?.toLowerCase().trim();
        const limit =
          typeof options?.limit === "number" && Number.isFinite(options.limit)
            ? Math.max(1, Math.min(Math.round(options.limit), 200))
            : 100;
        return consoleLogsRef.current
          .filter((entry) => levels.size === 0 || levels.has(entry.level))
          .filter((entry) => !filter || entry.message.toLowerCase().includes(filter))
          .slice(-limit);
      },
      reload: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.reload();
      },
      setZoomFactor: (factor) => {
        if (!readyRef.current || !webviewRef.current) return;
        setWebviewZoomFactor(webviewRef.current, factor);
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
  }, [animateAgentPointer, navigate, onHandleChange, readSnapshot, tab.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAgentPointerActionTimer();
      cancelAgentPointerAnimation();
    };
  }, [cancelAgentPointerAnimation, clearAgentPointerActionTimer]);

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
    const handleConsoleMessage = (event: Event) => {
      const detail = event as Event & {
        level?: number | string;
        message?: string;
        sourceId?: string;
      };
      const message = typeof detail.message === "string" ? detail.message : "";
      if (!message) {
        return;
      }
      consoleLogsRef.current = [
        ...consoleLogsRef.current.slice(-199),
        {
          level: normalizeConsoleLogLevel(detail.level),
          message,
          timestamp: new Date().toISOString(),
          ...(detail.sourceId ? { url: detail.sourceId } : {}),
        },
      ];
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
      setDesignDraft(null);
      setDesignInstructions("");
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
    webview.addEventListener("console-message", handleConsoleMessage);
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
      webview.removeEventListener("console-message", handleConsoleMessage);
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

  const cancelDesignCapture = useCallback(() => {
    setSelectionRect(null);
    setHoveredElementCapture(null);
    dragSelectionRef.current = null;
    designRequestPanelRequestIdRef.current = null;
    pendingElementHoverPointRef.current = null;
    setDesignDraft(null);
    setDesignInstructions("");
    setDesignRequestPanelPosition(null);
    setIsSubmittingDesignRequest(false);
    cancelDesignCaptureEvent();
  }, [cancelDesignCaptureEvent]);

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
      if (elementCommentWheelFrameRef.current !== null) {
        window.cancelAnimationFrame(elementCommentWheelFrameRef.current);
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
  const flushElementCommentWheel = useCallback(() => {
    elementCommentWheelFrameRef.current = null;
    const pendingWheel = pendingElementCommentWheelRef.current;
    if (!pendingWheel) {
      return;
    }
    pendingElementCommentWheelRef.current = null;
    forwardElementCommentWheelToWebview(pendingWheel);
  }, [forwardElementCommentWheelToWebview]);

  const onCaptureOverlayWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!active || !designerModeActive || designerTool !== "element-comment" || designDraft) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      lastElementCommentWheelAtRef.current = Date.now();
      elementHoverRequestTokenRef.current += 1;
      pendingElementHoverPointRef.current = null;
      if (elementHoverFrameRef.current !== null) {
        window.cancelAnimationFrame(elementHoverFrameRef.current);
        elementHoverFrameRef.current = null;
      }
      const deltaMultiplier =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? (overlayRef.current?.clientHeight ?? 1)
            : 1;
      const deltaX = event.deltaX * deltaMultiplier;
      const deltaY = event.deltaY * deltaMultiplier;
      pendingElementCommentWheelRef.current = pendingElementCommentWheelRef.current
        ? {
            clientX: event.clientX,
            clientY: event.clientY,
            deltaX: pendingElementCommentWheelRef.current.deltaX + deltaX,
            deltaY: pendingElementCommentWheelRef.current.deltaY + deltaY,
          }
        : {
            clientX: event.clientX,
            clientY: event.clientY,
            deltaX,
            deltaY,
          };
      if (elementCommentWheelFrameRef.current === null) {
        elementCommentWheelFrameRef.current =
          window.requestAnimationFrame(flushElementCommentWheel);
      }
    },
    [active, designDraft, designerModeActive, designerTool, flushElementCommentWheel],
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
    [cancelDesignCapture, captureDesignSelection, designerTool],
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
    [active, designDraft, designerModeActive, designerTool, flushHoveredElementInspection],
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
      if (
        Date.now() - lastElementCommentWheelAtRef.current <
        ELEMENT_HOVER_INSPECTION_SCROLL_PAUSE_MS
      ) {
        event.preventDefault();
        event.stopPropagation();
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

  const submitDesignDraft = useCallback(async () => {
    if (!designDraft || !onDesignCaptureSubmit || isSubmittingDesignRequest) {
      return;
    }
    const trimmedInstructions = normalizeDesignCommentToSingleLine(designInstructions).trim();
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
      const message = error instanceof Error ? error.message : "Could not add the comment.";
      reportDesignCaptureError(message);
    } finally {
      setIsSubmittingDesignRequest(false);
    }
  }, [
    cancelDesignCapture,
    designDraft,
    designInstructions,
    isSubmittingDesignRequest,
    onDesignCaptureSubmit,
  ]);

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
  useEffect(() => {
    const resetPointerInteractions = () => {
      const overlay = overlayRef.current;
      const dragSelection = dragSelectionRef.current;
      if (overlay && dragSelection && overlay.hasPointerCapture(dragSelection.pointerId)) {
        overlay.releasePointerCapture(dragSelection.pointerId);
      }
      dragSelectionRef.current = null;
      setSelectionRect(null);
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
    selectionRect ??
    (designerTool === "element-comment" ? (hoveredElementCapture?.targetRect ?? null) : null);
  const agentPointerScrollAxis =
    agentPointer && Math.abs(agentPointer.scrollX) > Math.abs(agentPointer.scrollY) ? "x" : "y";
  const agentPointerScrollDirection =
    agentPointerScrollAxis === "x"
      ? (agentPointer?.scrollX ?? 0) >= 0
        ? 1
        : -1
      : (agentPointer?.scrollY ?? 0) >= 0
        ? 1
        : -1;
  const agentPointerScrollRotation =
    agentPointerScrollAxis === "x"
      ? agentPointerScrollDirection >= 0
        ? 90
        : -90
      : agentPointerScrollDirection >= 0
        ? 0
        : 180;
  const canSubmitDesignDraft = designDraft ? designInstructions.trim().length > 0 : false;

  return (
    <div
      aria-hidden={!active}
      className={cn("absolute inset-0 min-h-0 [&_webview]:size-full", active ? "block" : "hidden")}
    >
      <div ref={hostRef} className="size-full min-h-0" />
      {agentPointer?.visible ? (
        <div className="pointer-events-none absolute inset-0 z-[35] overflow-hidden">
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate3d(${agentPointer.x}px, ${agentPointer.y}px, 0) scale(${
                agentPointer.pressed ? 0.96 : 1
              })`,
            }}
          >
            {agentPointer.pressed ? (
              <span className="absolute -left-3 -top-3 size-7 rounded-full border border-sky-400/70 bg-sky-400/12 shadow-[0_0_18px_rgba(56,189,248,0.26)]" />
            ) : null}
            {agentPointer.mode === "scroll" ? (
              <span
                className="absolute left-5 top-4 flex size-8 items-center justify-center rounded-full border border-sky-400/35 bg-background/78 text-sky-300 shadow-lg shadow-black/10 backdrop-blur-md"
                style={{ transform: `rotate(${agentPointerScrollRotation}deg)` }}
                aria-hidden="true"
              >
                <span className="flex -translate-y-0.5 flex-col items-center gap-0.5 animate-bounce">
                  <span className="size-1.5 rotate-45 border-b border-r border-current" />
                  <span className="size-1.5 rotate-45 border-b border-r border-current opacity-70" />
                </span>
              </span>
            ) : null}
            <MousePointer2Icon
              className="size-5 -translate-x-0.5 -translate-y-0.5 fill-background stroke-sky-300 drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"
              strokeWidth={2.4}
              aria-hidden="true"
            />
          </div>
        </div>
      ) : null}
      {(designerModeActive || activeOverlaySelection || designDraft) && (
        <div
          ref={overlayRef}
          className={cn(
            "absolute inset-0 z-20",
            designerModeActive || designDraft ? "pointer-events-auto" : "pointer-events-none",
            !designDraft && designerModeActive
              ? designerTool === "element-comment"
                ? "cursor-cell"
                : "cursor-crosshair"
              : null,
          )}
          onPointerDown={onCaptureOverlayPointerDown}
          onPointerMove={onCaptureOverlayPointerMove}
          onPointerUp={onCaptureOverlayPointerEnd}
          onPointerCancel={onCaptureOverlayPointerEnd}
          onWheel={onCaptureOverlayWheel}
        >
          {activeOverlaySelection ? (
            <BrowserDesignSelectionBox rect={activeOverlaySelection} />
          ) : null}
          {designDraft && designRequestPanelStyle && (
            <form
              ref={designRequestPanelRef}
              className="absolute z-30 flex h-12 w-[360px] max-w-[calc(100%-16px)] items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 shadow-[0_16px_38px_rgba(0,0,0,0.18)] backdrop-blur-xl"
              style={designRequestPanelStyle}
              onSubmit={(event) => {
                event.preventDefault();
                void submitDesignDraft();
              }}
            >
              <input
                value={designInstructions}
                onChange={(event) =>
                  setDesignInstructions(normalizeDesignCommentToSingleLine(event.target.value))
                }
                placeholder="Comment for the agent"
                className="h-9 min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] font-medium outline-none placeholder:text-muted-foreground/55"
                autoFocus
              />
              <button
                type="submit"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                disabled={isSubmittingDesignRequest || !canSubmitDesignDraft}
                aria-label="Submit comment"
                title="Submit comment"
              >
                <ArrowUpRightIcon className="size-4" />
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
