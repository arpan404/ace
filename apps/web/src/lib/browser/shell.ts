import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import {
  DEFAULT_PIP_HEIGHT_PX,
  DEFAULT_PIP_WIDTH_PX,
  MIN_PIP_HEIGHT_PX,
  MIN_PIP_WIDTH_PX,
  PIP_MARGIN_PX,
} from "~/lib/browser/types";

export type BrowserPipBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserViewportRect = {
  width: number;
  height: number;
};

export function isBrowserModifierPressed(
  event: Pick<ReactKeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  return event.altKey === false && (isMac ? event.metaKey : event.ctrlKey);
}

export function resolveViewportHeight(): number {
  return typeof window !== "undefined" ? window.innerHeight : 900;
}

export function resolveViewportRect(
  viewportRef?: RefObject<HTMLDivElement | null>,
): BrowserViewportRect {
  const viewport = viewportRef?.current;
  if (viewport) {
    return {
      width: Math.max(0, Math.round(viewport.clientWidth)),
      height: Math.max(0, Math.round(viewport.clientHeight)),
    };
  }
  return {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 900,
  };
}

export function createDefaultPipBounds(viewportRect: BrowserViewportRect): BrowserPipBounds {
  const width = Math.min(
    DEFAULT_PIP_WIDTH_PX,
    Math.max(MIN_PIP_WIDTH_PX, viewportRect.width - PIP_MARGIN_PX * 2),
  );
  const height = Math.min(
    DEFAULT_PIP_HEIGHT_PX,
    Math.max(MIN_PIP_HEIGHT_PX, viewportRect.height - PIP_MARGIN_PX * 2),
  );
  return {
    width,
    height,
    x: Math.max(PIP_MARGIN_PX, viewportRect.width - width - PIP_MARGIN_PX),
    y: Math.max(PIP_MARGIN_PX, viewportRect.height - height - PIP_MARGIN_PX),
  };
}

export function clampPipBounds(
  bounds: BrowserPipBounds,
  viewportRect: BrowserViewportRect,
): BrowserPipBounds {
  const maxWidth = Math.max(MIN_PIP_WIDTH_PX, viewportRect.width - PIP_MARGIN_PX * 2);
  const maxHeight = Math.max(MIN_PIP_HEIGHT_PX, viewportRect.height - PIP_MARGIN_PX * 2);
  const width = Math.min(Math.max(Math.round(bounds.width), MIN_PIP_WIDTH_PX), maxWidth);
  const height = Math.min(Math.max(Math.round(bounds.height), MIN_PIP_HEIGHT_PX), maxHeight);
  return {
    width,
    height,
    x: Math.min(
      Math.max(Math.round(bounds.x), PIP_MARGIN_PX),
      Math.max(PIP_MARGIN_PX, viewportRect.width - width - PIP_MARGIN_PX),
    ),
    y: Math.min(
      Math.max(Math.round(bounds.y), PIP_MARGIN_PX),
      Math.max(PIP_MARGIN_PX, viewportRect.height - height - PIP_MARGIN_PX),
    ),
  };
}
