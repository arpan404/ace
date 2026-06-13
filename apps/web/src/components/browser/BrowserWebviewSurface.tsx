import { ArrowUpRightIcon, MousePointer2Icon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { buildBrowserElementCaptureScript } from "./browserElementCaptureScript";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { runAsyncTask } from "~/lib/async";
import type { BrowserDesignerTool } from "~/lib/browser/designer";
import {
  hasMinimumSelectionSize,
  isAbortedWebviewLoad,
  mapSelectionRectToCapturedImageCrop,
  normalizeDesignCommentToSingleLine,
  resolveElementCommentWheelForwardingMode,
  shouldRunElementHoverInspection,
} from "~/components/browser/browserWebviewSurfaceUtils";
import { type BrowserTabState, resolveBrowserTabTitle } from "~/lib/browser/session";
import {
  type BrowserAgentPointerEffect,
  type BrowserAgentPointerPoint,
  type BrowserDesignCaptureResult,
  type BrowserDesignCaptureSubmission,
  type BrowserDesignElementDescriptor,
  type BrowserDesignSelectionRect,
  type BrowserConsoleLogEntry,
  type BrowserFindOptions,
  type BrowserFindResult,
  type BrowserWebviewKeyboardInputEvent,
  type BrowserTabHandle,
  type BrowserTabSnapshotOptions,
  type BrowserTabSnapshot,
  type BrowserWebview,
} from "~/lib/browser/types";
import {
  normalizeBrowserHttpUrl,
  resolveBrowserDisplayUrl,
  resolveBrowserRelayUrl,
} from "~/lib/browser/url";
import { resolveLocalConnectionUrl } from "~/lib/connectionRouting";
import { useWorkspaceCommentPlaceholder } from "~/lib/editor/workspaceCommentPlaceholders";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BrowserLoadErrorPage } from "./BrowserLoadErrorPage";

const BROWSER_ZOOM_STEP = 0.1;
const MIN_BROWSER_ZOOM_FACTOR = 0.25;
const MAX_BROWSER_ZOOM_FACTOR = 3;

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

function formatBrowserLoadFailureMessage(input: { code?: number; description?: string }): string {
  const description = input.description?.trim();
  if (description) {
    return description.replace(/^ERR_/u, "").replaceAll("_", " ");
  }
  if (typeof input.code === "number") {
    return `Network error ${String(input.code)}`;
  }
  return "The page is unreachable.";
}

interface BrowserPageElementCapture {
  targetRect: BrowserDesignSelectionRect | null;
  target: BrowserDesignElementDescriptor | null;
  mainContainer: BrowserDesignElementDescriptor | null;
}

export interface BrowserLoadFailure {
  code: number | null;
  message: string;
  url: string;
}

interface ActiveDragSelection {
  pointerId: number;
  startX: number;
  startY: number;
  hostWidth: number;
  hostHeight: number;
}

interface BrowserDesignCaptureDraft {
  capture: BrowserDesignCaptureResult | null;
  requestId: string;
  selection: BrowserDesignSelectionRect;
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

type BrowserDesignOverlayState = {
  selectionRect: BrowserDesignSelectionRect | null;
  hoveredElementCapture: BrowserPageElementCapture | null;
  designDraft: BrowserDesignCaptureDraft | null;
  designInstructions: string;
  isSubmittingDesignRequest: boolean;
  overlayViewportSize: OverlayViewportSize | null;
  designRequestPanelSize: FloatingOverlaySize;
  designRequestPanelPosition: DesignRequestPanelPosition | null;
  loadFailure: BrowserLoadFailure | null;
};

type BrowserDesignOverlayAction =
  | { type: "set-selection-rect"; selectionRect: BrowserDesignSelectionRect | null }
  | { type: "set-hovered-element-capture"; hoveredElementCapture: BrowserPageElementCapture | null }
  | { type: "set-design-draft"; designDraft: BrowserDesignCaptureDraft | null }
  | {
      type: "resolve-design-draft-capture";
      capture: BrowserDesignCaptureResult;
      requestId: string;
    }
  | { type: "set-design-instructions"; designInstructions: string }
  | { type: "set-submitting-design-request"; isSubmittingDesignRequest: boolean }
  | { type: "set-overlay-viewport-size"; overlayViewportSize: OverlayViewportSize | null }
  | { type: "set-design-request-panel-size"; designRequestPanelSize: FloatingOverlaySize }
  | {
      type: "set-design-request-panel-position";
      designRequestPanelPosition: DesignRequestPanelPosition | null;
    }
  | { type: "set-load-failure"; loadFailure: BrowserLoadFailure | null }
  | { type: "clear-design-capture" };

const EMPTY_BROWSER_DESIGN_OVERLAY_STATE: BrowserDesignOverlayState = {
  selectionRect: null,
  hoveredElementCapture: null,
  designDraft: null,
  designInstructions: "",
  isSubmittingDesignRequest: false,
  overlayViewportSize: null,
  designRequestPanelSize: DEFAULT_DESIGN_REQUEST_PANEL_SIZE,
  designRequestPanelPosition: null,
  loadFailure: null,
};

function browserDesignOverlayStateReducer(
  state: BrowserDesignOverlayState,
  action: BrowserDesignOverlayAction,
): BrowserDesignOverlayState {
  switch (action.type) {
    case "set-selection-rect":
      return state.selectionRect === action.selectionRect
        ? state
        : { ...state, selectionRect: action.selectionRect };
    case "set-hovered-element-capture":
      return state.hoveredElementCapture === action.hoveredElementCapture
        ? state
        : { ...state, hoveredElementCapture: action.hoveredElementCapture };
    case "set-design-draft":
      return state.designDraft === action.designDraft
        ? state
        : { ...state, designDraft: action.designDraft };
    case "resolve-design-draft-capture":
      return state.designDraft?.requestId === action.requestId
        ? {
            ...state,
            designDraft: {
              ...state.designDraft,
              capture: action.capture,
              selection: action.capture.selection,
            },
          }
        : state;
    case "set-design-instructions":
      return state.designInstructions === action.designInstructions
        ? state
        : { ...state, designInstructions: action.designInstructions };
    case "set-submitting-design-request":
      return state.isSubmittingDesignRequest === action.isSubmittingDesignRequest
        ? state
        : { ...state, isSubmittingDesignRequest: action.isSubmittingDesignRequest };
    case "set-overlay-viewport-size":
      return state.overlayViewportSize?.width === action.overlayViewportSize?.width &&
        state.overlayViewportSize?.height === action.overlayViewportSize?.height
        ? state
        : { ...state, overlayViewportSize: action.overlayViewportSize };
    case "set-design-request-panel-size":
      return state.designRequestPanelSize.width === action.designRequestPanelSize.width &&
        state.designRequestPanelSize.height === action.designRequestPanelSize.height
        ? state
        : { ...state, designRequestPanelSize: action.designRequestPanelSize };
    case "set-design-request-panel-position":
      return state.designRequestPanelPosition?.left === action.designRequestPanelPosition?.left &&
        state.designRequestPanelPosition?.top === action.designRequestPanelPosition?.top
        ? state
        : { ...state, designRequestPanelPosition: action.designRequestPanelPosition };
    case "set-load-failure":
      return state.loadFailure?.code === action.loadFailure?.code &&
        state.loadFailure?.message === action.loadFailure?.message &&
        state.loadFailure?.url === action.loadFailure?.url
        ? state
        : { ...state, loadFailure: action.loadFailure };
    case "clear-design-capture":
      return {
        ...state,
        selectionRect: null,
        hoveredElementCapture: null,
        designDraft: null,
        designInstructions: "",
        isSubmittingDesignRequest: false,
        designRequestPanelPosition: null,
      };
  }
}

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
  const selection = draft.selection;
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

function normalizeBrowserInputKey(rawKey: string): {
  keyCode: string;
  modifiers: NonNullable<BrowserWebviewKeyboardInputEvent["modifiers"]>;
} {
  const modifierSet = new Set<NonNullable<BrowserWebviewKeyboardInputEvent["modifiers"]>[number]>();
  const parts = rawKey.split("+").flatMap((part) => {
    const trimmedPart = part.trim();
    return trimmedPart.length > 0 ? [trimmedPart] : [];
  });
  const keyPart = parts.pop() ?? rawKey;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "alt":
      case "option":
        modifierSet.add("alt");
        break;
      case "cmd":
      case "command":
      case "meta":
      case "super":
      case "win":
      case "windows":
        modifierSet.add("meta");
        break;
      case "control":
      case "ctrl":
        modifierSet.add("control");
        break;
      case "ctrlorcmd":
      case "ctrlormeta":
      case "controlorcommand":
      case "controlormeta":
      case "mod":
        modifierSet.add(isMacPlatform(navigator.platform) ? "meta" : "control");
        break;
      case "shift":
        modifierSet.add("shift");
        break;
    }
  }

  const keyCodeByAlias: Record<string, string> = {
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    arrowup: "Up",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    down: "Down",
    end: "End",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    home: "Home",
    insert: "Insert",
    left: "Left",
    pagedown: "PageDown",
    pageup: "PageUp",
    return: "Enter",
    right: "Right",
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    up: "Up",
  };
  const normalizedKey = keyCodeByAlias[keyPart.toLowerCase()] ?? keyPart;
  return {
    keyCode: normalizedKey.length === 1 ? normalizedKey.toUpperCase() : normalizedKey,
    modifiers: Array.from(modifierSet),
  };
}

function sendBrowserKey(webview: BrowserWebview, rawKey: string): void {
  if (!webview.sendInputEvent) {
    throw new Error("The browser tab cannot receive native keyboard input.");
  }
  const { keyCode, modifiers } = normalizeBrowserInputKey(rawKey);
  webview.focus?.();
  const keyDownEvent: BrowserWebviewKeyboardInputEvent = { keyCode, type: "keyDown" };
  const keyUpEvent: BrowserWebviewKeyboardInputEvent = { keyCode, type: "keyUp" };
  if (modifiers.length > 0) {
    keyDownEvent.modifiers = modifiers;
    keyUpEvent.modifiers = modifiers;
  }
  webview.sendInputEvent(keyDownEvent);
  webview.sendInputEvent(keyUpEvent);
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

function readWebviewValue<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function normalizeFindInPageResult(value: unknown): BrowserFindResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const matches = record.matches;
  const activeMatchOrdinal = record.activeMatchOrdinal;
  return {
    activeMatchOrdinal:
      typeof activeMatchOrdinal === "number" && Number.isFinite(activeMatchOrdinal)
        ? activeMatchOrdinal
        : 0,
    finalUpdate: record.finalUpdate === true,
    matches: typeof matches === "number" && Number.isFinite(matches) ? matches : 0,
  };
}

function useBrowserTabWebviewComponent(props: {
  active: boolean;
  browserPartition: string;
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
  onFindResultChange?: (tabId: string, result: BrowserFindResult | null) => void;
  onOpenUrlInNewTab?: (url: string) => void;
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
    browserPartition,
    connectionUrl,
    designerModeActive = false,
    designerTool = "area-comment",
    onBrowserLoadError,
    onDesignCaptureCancel,
    onDesignCaptureError,
    onDesignCaptureSubmit,
    onContextMenuFallbackRequest,
    onFindResultChange,
    onOpenUrlInNewTab,
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
  const designRequestPanelRef = useRef<HTMLDivElement | null>(null);
  const dragSelectionRef = useRef<ActiveDragSelection | null>(null);
  const designRequestPanelRequestIdRef = useRef<string | null>(null);
  const focusedDesignRequestIdRef = useRef<string | null>(null);
  const previousDesignRequestPanelLayoutRef = useRef<{
    panelSize: FloatingOverlaySize;
    viewport: OverlayViewportSize;
  } | null>(null);
  const elementHoverFrameRef = useRef<number | null>(null);
  const flushHoveredElementInspectionRef = useRef<(() => void) | null>(null);
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
  const localConnectionUrl = resolveLocalConnectionUrl();
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);
  const [designOverlayState, dispatchDesignOverlayState] = useReducer(
    browserDesignOverlayStateReducer,
    EMPTY_BROWSER_DESIGN_OVERLAY_STATE,
  );
  const {
    selectionRect,
    hoveredElementCapture,
    designDraft,
    designInstructions,
    isSubmittingDesignRequest,
    overlayViewportSize,
    designRequestPanelSize,
    designRequestPanelPosition,
    loadFailure,
  } = designOverlayState;
  const [agentPointer, setAgentPointer] = useState<AgentBrowserPointerState | null>(null);
  const commentPlaceholder = useWorkspaceCommentPlaceholder(
    "design",
    designDraft?.requestId ?? null,
  );
  const setDesignRequestInputRef = (node: HTMLInputElement | null) => {
    const requestId = designDraft?.requestId ?? null;
    if (!node || !requestId || focusedDesignRequestIdRef.current === requestId) {
      return;
    }
    focusedDesignRequestIdRef.current = requestId;
    node.focus();
  };
  const emitTabSnapshotChange = useStableCallback(
    (snapshot: BrowserTabSnapshot, options?: BrowserTabSnapshotOptions) => {
      onSnapshotChange(tab.id, snapshot, options);
    },
  );
  const reportBrowserLoadError = useStableCallback((message: string) => {
    onBrowserLoadError?.(message);
  });
  const reportDesignCaptureError = useStableCallback((message: string) => {
    onDesignCaptureError?.(message);
  });
  const cancelDesignCapture = useStableCallback(() => {
    dispatchDesignOverlayState({ type: "clear-design-capture" });
    dragSelectionRef.current = null;
    designRequestPanelRequestIdRef.current = null;
    pendingElementHoverPointRef.current = null;
    onDesignCaptureCancel?.();
  });
  const requestContextMenuFallback = useStableCallback(
    (position: { x: number; y: number }, requestedAt: number) => {
      onContextMenuFallbackRequest(tab.id, position, requestedAt);
    },
  );
  const requestOpenUrlInNewTab = useStableCallback((url: string) => {
    onOpenUrlInNewTab?.(url);
  });
  const emitFindResultChange = useStableCallback((result: BrowserFindResult | null) => {
    onFindResultChange?.(tab.id, result);
  });
  const commitHoveredElementCapture = useStableCallback(
    (capture: BrowserPageElementCapture | null, point: { x: number; y: number } | null) => {
      hoveredElementCaptureRef.current = capture;
      hoveredElementPointRef.current = point;
      const nextCapture = (() => {
        const current = hoveredElementCaptureRef.current;
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
      })();
      dispatchDesignOverlayState({
        type: "set-hovered-element-capture",
        hoveredElementCapture: nextCapture,
      });
    },
  );
  const clearHoveredElementCapture = useStableCallback(() => {
    elementHoverRequestTokenRef.current += 1;
    latestElementHoverPointRef.current = null;
    pendingElementHoverPointRef.current = null;
    if (elementHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(elementHoverFrameRef.current);
      elementHoverFrameRef.current = null;
    }
    commitHoveredElementCapture(null, null);
  });
  const clearElementInteractionFrames = useStableCallback(() => {
    clearHoveredElementCapture();
    if (elementCommentWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(elementCommentWheelFrameRef.current);
      elementCommentWheelFrameRef.current = null;
    }
  });

  const resolveLoadUrl = useStableCallback((url: string) =>
    resolveBrowserRelayUrl({
      url,
      ownerConnectionUrl: connectionUrl,
      localConnectionUrl,
    }),
  );

  const resolveSnapshotUrl = useStableCallback((currentUrl: string) => {
    const displayUrl = resolveBrowserDisplayUrl(currentUrl);
    return normalizeBrowserHttpUrl(displayUrl) ?? requestedUrlRef.current;
  });

  const emitSnapshotNow = useStableCallback((options?: BrowserTabSnapshotOptions) => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return;
    }
    const resolvedUrl = resolveSnapshotUrl(
      readWebviewValue(() => webview.getURL(), requestedUrlRef.current),
    );
    emitTabSnapshotChange(
      {
        canGoBack: readWebviewValue(() => webview.canGoBack(), false),
        canGoForward: readWebviewValue(() => webview.canGoForward(), false),
        devToolsOpen: readWebviewValue(() => webview.isDevToolsOpened(), false),
        loading: readWebviewValue(() => webview.isLoading(), false),
        title: resolveBrowserTabTitle(
          resolvedUrl,
          readWebviewValue(() => webview.getTitle(), ""),
        ),
        url: resolvedUrl,
      },
      options,
    );
  });

  const readSnapshot = useStableCallback((): BrowserTabSnapshot | null => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      return null;
    }
    const resolvedUrl = resolveSnapshotUrl(
      readWebviewValue(() => webview.getURL(), requestedUrlRef.current),
    );
    return {
      canGoBack: readWebviewValue(() => webview.canGoBack(), false),
      canGoForward: readWebviewValue(() => webview.canGoForward(), false),
      devToolsOpen: readWebviewValue(() => webview.isDevToolsOpened(), false),
      loading: readWebviewValue(() => webview.isLoading(), false),
      title: resolveBrowserTabTitle(
        resolvedUrl,
        readWebviewValue(() => webview.getTitle(), ""),
      ),
      url: resolvedUrl,
    };
  });

  const flushScheduledSnapshot = useStableCallback(() => {
    snapshotFlushTimerRef.current = null;
    const options = pendingSnapshotOptionsRef.current ?? undefined;
    pendingSnapshotOptionsRef.current = null;
    emitSnapshotNow(options);
  });

  const scheduleEmitSnapshot = useStableCallback((options: BrowserTabSnapshotOptions = {}) => {
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
  });

  const cancelScheduledSnapshot = useStableCallback(() => {
    if (snapshotFlushTimerRef.current !== null) {
      window.clearTimeout(snapshotFlushTimerRef.current);
      snapshotFlushTimerRef.current = null;
    }
    pendingSnapshotOptionsRef.current = null;
  });
  const resolveLoadUrlEvent = useStableCallback((url: string) => resolveLoadUrl(url));
  const resolveSnapshotUrlEvent = useStableCallback((currentUrl: string) =>
    resolveSnapshotUrl(currentUrl),
  );
  const scheduleEmitSnapshotEvent = useStableCallback((options?: BrowserTabSnapshotOptions) => {
    scheduleEmitSnapshot(options);
  });

  const navigate = useStableCallback((url: string) => {
    dispatchDesignOverlayState({ type: "set-load-failure", loadFailure: null });
    requestedUrlRef.current = url;
    const webview = webviewRef.current;
    if (!webview || !readyRef.current) {
      pendingUrlRef.current = url;
      return;
    }
    const currentUrl = normalizeBrowserHttpUrl(
      resolveBrowserDisplayUrl(readWebviewValue(() => webview.getURL(), requestedUrlRef.current)),
    );
    if (currentUrl === normalizeBrowserHttpUrl(url)) {
      scheduleEmitSnapshot({ persistTab: true });
      return;
    }

    loadWebviewUrl(webview, resolveLoadUrl(url), (message) => {
      dispatchDesignOverlayState({
        type: "set-load-failure",
        loadFailure: {
          code: null,
          message,
          url,
        },
      });
      reportBrowserLoadError(message);
    });
  });

  const inspectBrowserPoint = async (point: {
    x: number;
    y: number;
  }): Promise<BrowserPageElementCapture | null> => {
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
  };

  const captureDesignSelection = async (
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
  };

  const clearAgentPointerActionTimer = useStableCallback(() => {
    if (agentPointerActionTimerRef.current === null) {
      return;
    }
    window.clearTimeout(agentPointerActionTimerRef.current);
    agentPointerActionTimerRef.current = null;
  });

  const cancelAgentPointerAnimation = useStableCallback(() => {
    if (agentPointerFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(agentPointerFrameRef.current);
    agentPointerFrameRef.current = null;
  });

  const resolveAgentPointerViewport = useStableCallback(() => {
    const host = overlayRef.current ?? hostRef.current;
    return {
      height: Math.max(1, Math.round(host?.clientHeight ?? 1)),
      width: Math.max(1, Math.round(host?.clientWidth ?? 1)),
    };
  });

  const clampAgentPointerPoint = useStableCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      const viewport = resolveAgentPointerViewport();
      return {
        x: Math.max(0, Math.min(viewport.width, Math.round(point.x))),
        y: Math.max(0, Math.min(viewport.height, Math.round(point.y))),
      };
    },
  );

  const resolveAgentPointerPoint = useStableCallback(
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
  );

  const setAgentPointerFrame = useStableCallback(
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
  );

  const scheduleAgentPointerRest = useStableCallback((token: number, delayMs: number) => {
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
  });

  const clearAgentPointerRuntime = useStableCallback(() => {
    agentPointerTokenRef.current += 1;
    clearAgentPointerActionTimer();
    cancelAgentPointerAnimation();
    agentPointerPositionRef.current = null;
  });

  const clearAgentPointer = useStableCallback(() => {
    clearAgentPointerRuntime();
    setAgentPointer(null);
  });

  const animateAgentPointerTo = useStableCallback(
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
  );
  const animateAgentPointer = useStableCallback(
    async (effect: BrowserAgentPointerEffect): Promise<void> => {
      const animateActiveAgentPointerTo = async (
        point: BrowserAgentPointerPoint,
        options: {
          durationMultiplier?: number;
          pressed?: boolean | undefined;
          token: number;
        },
      ): Promise<boolean> => {
        await animateAgentPointerTo(effect, point, options);
        return agentPointerTokenRef.current === options.token;
      };
      const waitForActiveAgentPointerFrame = async (
        activeToken: number,
        ms: number,
      ): Promise<boolean> => {
        await waitForBrowserPointerFrame(ms);
        return agentPointerTokenRef.current === activeToken;
      };

      if (!activeRef.current) {
        return;
      }
      const token = agentPointerTokenRef.current + 1;
      agentPointerTokenRef.current = token;
      clearAgentPointerActionTimer();

      const path = effect.path
        ? effect.path.reduce<Array<{ x: number; y: number }>>((points, point) => {
            if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
              points.push(clampAgentPointerPoint(point));
            }
            return points;
          }, [])
        : undefined;

      if (effect.type === "drag" && path && path.length >= 2) {
        if (
          !(await animateActiveAgentPointerTo(path[0]!, {
            durationMultiplier: 0.82,
            pressed: false,
            token,
          }))
        ) {
          return;
        }
        setAgentPointerFrame(effect, path[0]!, { pressed: true });
        if (!(await waitForActiveAgentPointerFrame(token, 80))) {
          return;
        }
        const steps = path.slice(1);
        const animateDragMovement = async (index: number): Promise<void> => {
          const point = steps[index];
          if (!point || agentPointerTokenRef.current !== token) {
            return;
          }
          if (
            !(await animateActiveAgentPointerTo(point, {
              durationMultiplier: 0.62,
              pressed: true,
              token,
            }))
          ) {
            return;
          }
          await animateDragMovement(index + 1);
        };
        if (!(await animateDragMovement(0).then(() => agentPointerTokenRef.current === token))) {
          return;
        }
        setAgentPointerFrame(effect, path[path.length - 1]!, { pressed: false });
        scheduleAgentPointerRest(token, 260);
        return;
      }

      const point = resolveAgentPointerPoint(effect);
      if (
        !(await animateActiveAgentPointerTo(point, {
          durationMultiplier: effect.type === "scroll" ? 0.78 : 1,
          pressed: false,
          token,
        }))
      ) {
        return;
      }
      if (effect.type === "click" || effect.type === "double_click") {
        setAgentPointerFrame(effect, point, { pressed: true });
        if (
          !(await waitForActiveAgentPointerFrame(token, effect.type === "double_click" ? 90 : 80))
        ) {
          return;
        }
        setAgentPointerFrame(effect, point, { pressed: false });
        if (effect.type === "double_click") {
          if (!(await waitForActiveAgentPointerFrame(token, 80))) {
            return;
          }
          setAgentPointerFrame(effect, point, { pressed: true });
          if (!(await waitForActiveAgentPointerFrame(token, 80))) {
            return;
          }
          setAgentPointerFrame(effect, point, { pressed: false });
        }
        scheduleAgentPointerRest(token, 220);
        return;
      }
      scheduleAgentPointerRest(token, effect.type === "scroll" ? 620 : 180);
    },
  );

  const browserTabHandle = useMemo<BrowserTabHandle>(
    () => ({
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
      clearAgentPointer,
      closeDevTools: () => {
        if (!readyRef.current || !webviewRef.current?.isDevToolsOpened()) return;
        webviewRef.current.closeDevTools();
      },
      executeJavaScript: async <T = unknown,>(code: string): Promise<T> => {
        const webview = webviewRef.current;
        if (!readyRef.current || !webview?.executeJavaScript) {
          throw new Error("The browser tab cannot execute JavaScript yet.");
        }
        return webview.executeJavaScript<T>(code, true);
      },
      findInPage: (query: string, options?: BrowserFindOptions) => {
        const webview = webviewRef.current;
        if (!readyRef.current || !webview) {
          return;
        }
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
          webview.stopFindInPage?.("clearSelection");
          emitFindResultChange(null);
          return;
        }
        if (webview.findInPage) {
          webview.findInPage(trimmedQuery, {
            findNext: options?.findNext === true,
            forward: options?.forward !== false,
            matchCase: options?.matchCase === true,
          });
          return;
        }
        if (webview.executeJavaScript) {
          void webview.executeJavaScript(
            `window.find(${JSON.stringify(trimmedQuery)}, ${JSON.stringify(options?.matchCase === true)}, ${JSON.stringify(options?.forward === false)}, false, false, false, false)`,
            true,
          );
        }
      },
      getZoomFactor: () => {
        if (!readyRef.current || !webviewRef.current) return 1;
        return getWebviewZoomFactor(webviewRef.current);
      },
      getWebContentsId: () => {
        const id = webviewRef.current?.getWebContentsId?.();
        return typeof id === "number" && Number.isFinite(id) ? id : null;
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
        const filteredEntries = consoleLogsRef.current.filter((entry) => {
          if (levels.size > 0 && !levels.has(entry.level)) {
            return false;
          }
          if (filter && !entry.message.toLowerCase().includes(filter)) {
            return false;
          }
          return true;
        });
        return filteredEntries.slice(-limit);
      },
      reload: () => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.reload();
      },
      pressKeys: async (keys) => {
        const webview = webviewRef.current;
        if (!readyRef.current || !webview) {
          throw new Error("The browser tab cannot receive keyboard input yet.");
        }
        await keys.reduce<Promise<void>>((chain, key) => {
          return chain.then(() => {
            sendBrowserKey(webview, key);
            return waitForBrowserPointerFrame(12);
          });
        }, Promise.resolve());
      },
      setZoomFactor: (factor) => {
        if (!readyRef.current || !webviewRef.current) return;
        setWebviewZoomFactor(webviewRef.current, factor);
      },
      stopFindInPage: (action = "clearSelection") => {
        if (!readyRef.current || !webviewRef.current) return;
        webviewRef.current.stopFindInPage?.(action);
        emitFindResultChange(null);
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
    }),
    [animateAgentPointer, clearAgentPointer, emitFindResultChange, navigate, readSnapshot],
  );

  useEffect(() => {
    onHandleChange(tab.id, browserTabHandle);
    return () => {
      onHandleChange(tab.id, null);
    };
  }, [browserTabHandle, onHandleChange, tab.id]);

  useEffect(() => {
    if (active) {
      return;
    }
    clearAgentPointerRuntime();
  }, [active, clearAgentPointerRuntime]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      agentPointerTokenRef.current += 1;
      clearAgentPointerActionTimer();
      cancelAgentPointerAnimation();
      agentPointerPositionRef.current = null;
    };
  }, [cancelAgentPointerAnimation, clearAgentPointerActionTimer]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || webviewRef.current) return;

    const webview = document.createElement("webview") as BrowserWebview;
    webview.className = "size-full bg-background";
    webview.setAttribute("partition", browserPartition);
    webview.setAttribute("allowpopups", "true");
    webview.setAttribute("src", resolveLoadUrlEvent(requestedUrlRef.current));

    const handleDomReady = () => {
      readyRef.current = true;
      const pendingUrl = pendingUrlRef.current;
      pendingUrlRef.current = null;
      if (
        pendingUrl &&
        normalizeBrowserHttpUrl(pendingUrl) !==
          normalizeBrowserHttpUrl(
            resolveBrowserDisplayUrl(
              readWebviewValue(() => webview.getURL(), requestedUrlRef.current),
            ),
          )
      ) {
        loadWebviewUrl(webview, resolveLoadUrlEvent(pendingUrl), (message) => {
          dispatchDesignOverlayState({
            type: "set-load-failure",
            loadFailure: {
              code: null,
              message,
              url: pendingUrl,
            },
          });
          reportBrowserLoadError(message);
        });
        return;
      }
      scheduleEmitSnapshotEvent({ persistTab: true });
    };
    const handleLoadStart = () => {
      dispatchDesignOverlayState({ type: "set-load-failure", loadFailure: null });
      emitTabSnapshotChange(
        {
          canGoBack: readyRef.current ? readWebviewValue(() => webview.canGoBack(), false) : false,
          canGoForward: readyRef.current
            ? readWebviewValue(() => webview.canGoForward(), false)
            : false,
          devToolsOpen: readyRef.current
            ? readWebviewValue(() => webview.isDevToolsOpened(), false)
            : false,
          loading: true,
          title: resolveBrowserTabTitle(requestedUrlRef.current),
          url: requestedUrlRef.current,
        },
        { persistTab: false },
      );
    };
    const handleNavigation = () => {
      dispatchDesignOverlayState({ type: "set-load-failure", loadFailure: null });
      scheduleEmitSnapshotEvent({ persistTab: true });
    };
    const handleLoadStop = () => {
      scheduleEmitSnapshotEvent({ persistTab: true, recordHistory: true });
    };
    const handleInPageNavigation = () => {
      scheduleEmitSnapshotEvent({ persistTab: true, recordHistory: true });
    };
    const handleFailLoad = (event: Event) => {
      const detail = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
        validatedURL?: string;
      };
      if (detail.errorCode === -3) {
        return;
      }
      if (detail.isMainFrame === false) {
        return;
      }
      cancelScheduledSnapshot();
      const resolvedUrl = resolveSnapshotUrlEvent(
        detail.validatedURL ?? readWebviewValue(() => webview.getURL(), requestedUrlRef.current),
      );
      dispatchDesignOverlayState({
        type: "set-load-failure",
        loadFailure: {
          code: typeof detail.errorCode === "number" ? detail.errorCode : null,
          message: formatBrowserLoadFailureMessage({
            ...(typeof detail.errorCode === "number" ? { code: detail.errorCode } : {}),
            ...(typeof detail.errorDescription === "string"
              ? { description: detail.errorDescription }
              : {}),
          }),
          url: resolvedUrl,
        },
      });
      emitTabSnapshotChange(
        {
          canGoBack: readyRef.current ? readWebviewValue(() => webview.canGoBack(), false) : false,
          canGoForward: readyRef.current
            ? readWebviewValue(() => webview.canGoForward(), false)
            : false,
          devToolsOpen: readyRef.current
            ? readWebviewValue(() => webview.isDevToolsOpened(), false)
            : false,
          loading: false,
          title: resolveBrowserTabTitle(
            resolvedUrl,
            readWebviewValue(() => webview.getTitle(), ""),
          ),
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
    const handleNewWindow = (event: Event) => {
      const detail = event as Event & { url?: string };
      if (typeof detail.url !== "string" || detail.url.trim().length === 0) {
        return;
      }
      event.preventDefault();
      requestOpenUrlInNewTab(detail.url);
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
      dispatchDesignOverlayState({ type: "clear-design-capture" });
      hoveredElementCaptureRef.current = null;
      dragSelectionRef.current = null;
      cancelDesignCapture();
    };
    const handleFoundInPage = (event: Event) => {
      const detail = event as Event & { result?: unknown };
      emitFindResultChange(normalizeFindInPageResult(detail.result));
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
    webview.addEventListener("new-window", handleNewWindow);
    webview.addEventListener("console-message", handleConsoleMessage);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);
    webview.addEventListener("found-in-page", handleFoundInPage);

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
      webview.removeEventListener("new-window", handleNewWindow);
      webview.removeEventListener("console-message", handleConsoleMessage);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
      webview.removeEventListener("found-in-page", handleFoundInPage);
      stopWebviewBeforeRemoval(webview);
      host.replaceChildren();
      webviewRef.current = null;
      readyRef.current = false;
      cancelScheduledSnapshot();
    };
  }, [
    browserPartition,
    cancelDesignCapture,
    cancelScheduledSnapshot,
    emitFindResultChange,
    emitTabSnapshotChange,
    reportBrowserLoadError,
    requestContextMenuFallback,
    requestOpenUrlInNewTab,
    resolveLoadUrlEvent,
    resolveSnapshotUrlEvent,
    scheduleEmitSnapshotEvent,
  ]);

  useLayoutEffect(() => {
    navigate(tab.url);
  }, [navigate, tab.url]);

  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    if (designerModeActive) {
      return;
    }
    if (!designDraft) {
      dispatchDesignOverlayState({ type: "set-selection-rect", selectionRect: null });
      clearHoveredElementCapture();
      dragSelectionRef.current = null;
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, clearHoveredElementCapture, designDraft, designerModeActive]);

  useLayoutEffect(() => {
    if (designerTool === "element-comment") {
      return;
    }
    clearHoveredElementCapture();
  }, [clearHoveredElementCapture, designerTool]);

  useLayoutEffect(() => {
    if (!designDraft || designDraft.tool === designerTool) {
      return;
    }
    cancelDesignCapture();
  }, [cancelDesignCapture, designDraft, designerTool]);

  useEffect(() => {
    return () => {
      clearElementInteractionFrames();
    };
  }, [clearElementInteractionFrames]);

  const forwardElementCommentWheelToWebview = (input: {
    deltaX: number;
    deltaY: number;
    clientX: number;
    clientY: number;
  }) => {
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
  };
  const flushElementCommentWheel = () => {
    elementCommentWheelFrameRef.current = null;
    const pendingWheel = pendingElementCommentWheelRef.current;
    if (!pendingWheel) {
      return;
    }
    pendingElementCommentWheelRef.current = null;
    forwardElementCommentWheelToWebview(pendingWheel);
  };

  const onCaptureOverlayWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!active || !designerModeActive || designerTool !== "element-comment" || designDraft) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    lastElementCommentWheelAtRef.current = Date.now();
    elementHoverRequestTokenRef.current += 1;
    pendingElementHoverPointRef.current = null;
    commitHoveredElementCapture(null, null);
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
      elementCommentWheelFrameRef.current = window.requestAnimationFrame(flushElementCommentWheel);
    }
  };

  const startCapturedDraft = (
    selection: BrowserDesignSelectionRect,
    inspectedPoint?: BrowserPageElementCapture | null,
    failureMessage = "Could not capture the selected browser area.",
  ) => {
    elementHoverRequestTokenRef.current += 1;
    dispatchDesignOverlayState({ type: "set-selection-rect", selectionRect: selection });
    const requestId = generateDesignRequestId();
    const host = overlayRef.current;
    const viewportWidth = host?.clientWidth ?? 0;
    const viewportHeight = host?.clientHeight ?? 0;
    dispatchDesignOverlayState({ type: "set-design-instructions", designInstructions: "" });
    dispatchDesignOverlayState({
      type: "set-design-draft",
      designDraft: {
        capture: null,
        requestId,
        selection,
        tool: designerTool,
        viewportWidth,
        viewportHeight,
      },
    });
    void captureDesignSelection(selection, requestId, inspectedPoint)
      .then((capture) => {
        if (!mountedRef.current) {
          return;
        }
        dispatchDesignOverlayState({
          type: "resolve-design-draft-capture",
          capture,
          requestId,
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
  };

  const flushHoveredElementInspection = useStableCallback(() => {
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
          elementHoverFrameRef.current = window.requestAnimationFrame(() => {
            flushHoveredElementInspectionRef.current?.();
          });
        }
      });
  });
  useLayoutEffect(() => {
    flushHoveredElementInspectionRef.current = flushHoveredElementInspection;
  }, [flushHoveredElementInspection]);

  const onCaptureOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
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
    dispatchDesignOverlayState({ type: "set-selection-rect", selectionRect: initialRect });
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onCaptureOverlayPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragSelection = dragSelectionRef.current;
    if (dragSelection && dragSelection.pointerId === event.pointerId) {
      const host = overlayRef.current;
      if (!host) {
        return;
      }
      const bounds = host.getBoundingClientRect();
      dispatchDesignOverlayState({
        type: "set-selection-rect",
        selectionRect: normalizeSelectionRect({
          startX: dragSelection.startX,
          startY: dragSelection.startY,
          currentX: event.clientX - bounds.left,
          currentY: event.clientY - bounds.top,
          hostWidth: dragSelection.hostWidth,
          hostHeight: dragSelection.hostHeight,
        }),
      });
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
  };

  const onCaptureOverlayPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
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
        dispatchDesignOverlayState({ type: "set-selection-rect", selectionRect: null });
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
  };

  const submitDesignDraft = async () => {
    if (!designDraft?.capture || !onDesignCaptureSubmit || isSubmittingDesignRequest) {
      return;
    }
    const trimmedInstructions = normalizeDesignCommentToSingleLine(designInstructions).trim();
    if (trimmedInstructions.length === 0) {
      return;
    }
    dispatchDesignOverlayState({
      type: "set-submitting-design-request",
      isSubmittingDesignRequest: true,
    });
    const capture = designDraft.capture;
    try {
      await onDesignCaptureSubmit({
        ...capture,
        instructions: trimmedInstructions,
      });
      cancelDesignCapture();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add the comment.";
      reportDesignCaptureError(message);
      dispatchDesignOverlayState({
        type: "set-submitting-design-request",
        isSubmittingDesignRequest: false,
      });
      return;
    }
    dispatchDesignOverlayState({
      type: "set-submitting-design-request",
      isSubmittingDesignRequest: false,
    });
  };

  useEffect(() => {
    if (!designDraft) {
      dispatchDesignOverlayState({ type: "set-overlay-viewport-size", overlayViewportSize: null });
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
      dispatchDesignOverlayState({
        type: "set-overlay-viewport-size",
        overlayViewportSize: nextSize,
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
      dispatchDesignOverlayState({
        type: "set-design-request-panel-size",
        designRequestPanelSize: DEFAULT_DESIGN_REQUEST_PANEL_SIZE,
      });
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
      dispatchDesignOverlayState({
        type: "set-design-request-panel-size",
        designRequestPanelSize: nextSize,
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

  const designRequestPanelViewport: OverlayViewportSize | null = (() => {
    if (!designDraft) {
      return null;
    }
    return (
      overlayViewportSize ?? {
        width: designDraft.viewportWidth,
        height: designDraft.viewportHeight,
      }
    );
  })();
  const defaultDesignRequestPanelPosition: DesignRequestPanelPosition | null = (() => {
    if (!designDraft) {
      return null;
    }
    const viewport = designRequestPanelViewport;
    if (!viewport) {
      return null;
    }
    return resolveDefaultDesignRequestPanelPosition(designDraft, viewport, designRequestPanelSize);
  })();
  useEffect(() => {
    if (!designDraft || !defaultDesignRequestPanelPosition) {
      designRequestPanelRequestIdRef.current = null;
      dispatchDesignOverlayState({
        type: "set-design-request-panel-position",
        designRequestPanelPosition: null,
      });
      return;
    }
    if (designRequestPanelRequestIdRef.current === designDraft.requestId) {
      return;
    }
    designRequestPanelRequestIdRef.current = designDraft.requestId;
    previousDesignRequestPanelLayoutRef.current = null;
    dispatchDesignOverlayState({
      type: "set-design-request-panel-position",
      designRequestPanelPosition: defaultDesignRequestPanelPosition,
    });
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
    dispatchDesignOverlayState({
      type: "set-design-request-panel-position",
      designRequestPanelPosition: clampedPosition,
    });
  }, [designRequestPanelPosition, designRequestPanelSize, designRequestPanelViewport]);
  useEffect(() => {
    const resetPointerInteractions = () => {
      const overlay = overlayRef.current;
      const dragSelection = dragSelectionRef.current;
      if (overlay && dragSelection && overlay.hasPointerCapture(dragSelection.pointerId)) {
        overlay.releasePointerCapture(dragSelection.pointerId);
      }
      dragSelectionRef.current = null;
      dispatchDesignOverlayState({ type: "set-selection-rect", selectionRect: null });
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
  const designRequestPanelStyle: CSSProperties | undefined = (() => {
    const position = designRequestPanelPosition ?? defaultDesignRequestPanelPosition;
    if (!position || !designRequestPanelViewport) {
      return undefined;
    }
    return {
      ...position,
      maxWidth: `${Math.max(160, designRequestPanelViewport.width - DESIGN_REQUEST_PANEL_MARGIN_PX * 2)}px`,
    };
  })();
  const activeOverlaySelection =
    selectionRect ??
    (designerTool === "element-comment" ? (hoveredElementCapture?.targetRect ?? null) : null);
  const visibleAgentPointer = active ? agentPointer : null;
  const agentPointerScrollAxis =
    visibleAgentPointer &&
    Math.abs(visibleAgentPointer.scrollX) > Math.abs(visibleAgentPointer.scrollY)
      ? "x"
      : "y";
  const agentPointerScrollDirection =
    agentPointerScrollAxis === "x"
      ? (visibleAgentPointer?.scrollX ?? 0) >= 0
        ? 1
        : -1
      : (visibleAgentPointer?.scrollY ?? 0) >= 0
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
  const canSubmitDesignDraft = designDraft?.capture ? designInstructions.trim().length > 0 : false;
  const retryFailedLoad = () => {
    const failedUrl = loadFailure?.url;
    if (!failedUrl) {
      return;
    }
    navigate(failedUrl);
  };

  return (
    <div
      aria-hidden={!active}
      className={cn("absolute inset-0 min-h-0 [&_webview]:size-full", active ? "block" : "hidden")}
    >
      <div ref={hostRef} className="size-full min-h-0" />
      {loadFailure ? (
        <BrowserLoadErrorPage failure={loadFailure} onRetry={retryFailedLoad} />
      ) : null}
      {visibleAgentPointer?.visible ? (
        <div className="pointer-events-none absolute inset-0 z-[35] overflow-hidden">
          <div
            className="absolute left-0 top-0"
            style={{
              transform: `translate3d(${visibleAgentPointer.x}px, ${visibleAgentPointer.y}px, 0) scale(${
                visibleAgentPointer.pressed ? 0.96 : 1
              })`,
            }}
          >
            {visibleAgentPointer.pressed ? (
              <span className="absolute -left-3 -top-3 size-7 rounded-full border border-primary/70 bg-primary/12 shadow-[0_0_18px_color-mix(in_srgb,var(--primary)_26%,transparent)]" />
            ) : null}
            {visibleAgentPointer.mode === "scroll" ? (
              <span
                className="absolute left-5 top-4 flex size-8 items-center justify-center rounded-full border border-primary/35 bg-background/78 text-primary shadow-lg shadow-black/10 backdrop-blur-md"
                style={{ transform: `rotate(${agentPointerScrollRotation}deg)` }}
                aria-hidden="true"
              >
                <span className="flex -translate-y-0.5 flex-col items-center gap-0.5">
                  <span className="size-1.5 rotate-45 border-b border-r border-current" />
                  <span className="size-1.5 rotate-45 border-b border-r border-current opacity-70" />
                </span>
              </span>
            ) : null}
            <MousePointer2Icon
              className="size-5 -translate-x-0.5 -translate-y-0.5 fill-background stroke-primary drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"
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
            <div
              ref={designRequestPanelRef}
              className="absolute z-30 flex h-12 w-[360px] max-w-[calc(100%-16px)] items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 shadow-[0_16px_38px_rgba(0,0,0,0.18)] backdrop-blur-xl"
              style={designRequestPanelStyle}
            >
              <input
                ref={setDesignRequestInputRef}
                aria-label="Design change request"
                value={designInstructions}
                onChange={(event) =>
                  dispatchDesignOverlayState({
                    type: "set-design-instructions",
                    designInstructions: normalizeDesignCommentToSingleLine(event.target.value),
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitDesignDraft();
                  }
                }}
                placeholder={commentPlaceholder}
                className="h-9 min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] font-medium outline-none placeholder:text-muted-foreground/55"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                      disabled={isSubmittingDesignRequest || !canSubmitDesignDraft}
                      aria-label="Submit comment"
                      onClick={() => {
                        void submitDesignDraft();
                      }}
                    />
                  }
                >
                  <ArrowUpRightIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="top">Submit comment</TooltipPopup>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BrowserTabWebview(props: Parameters<typeof useBrowserTabWebviewComponent>[0]) {
  return useBrowserTabWebviewComponent(props);
}
