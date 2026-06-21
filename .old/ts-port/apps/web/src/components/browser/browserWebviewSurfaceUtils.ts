import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { BrowserDesignerTool } from "~/lib/browser/designer";
import type { BrowserDesignSelectionRect } from "~/lib/browser/types";
import { isMacPlatform } from "~/lib/utils";

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

function clampPoint(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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
  minimumSizePx = 24,
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
