export const DEFAULT_RIGHT_SIDE_PANEL_WIDTH = 512;
export const MIN_RIGHT_SIDE_PANEL_WIDTH = 416;
export const MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH = 420;
export const RIGHT_SIDE_PANEL_RESIZE_HANDLE_WIDTH = 12;

const DEFAULT_BROWSER_RIGHT_SIDE_PANEL_WIDTH = 760;
const BROWSER_RIGHT_SIDE_PANEL_INITIAL_WIDTH_RATIO = 0.56;

export function clampRightSidePanelWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const maxWidth = Math.max(
    MIN_RIGHT_SIDE_PANEL_WIDTH,
    safeViewportWidth - MIN_RIGHT_SIDE_PANEL_CHAT_WIDTH,
  );
  const normalizedWidth = Number.isFinite(width)
    ? Math.round(width)
    : DEFAULT_RIGHT_SIDE_PANEL_WIDTH;
  return Math.min(maxWidth, Math.max(MIN_RIGHT_SIDE_PANEL_WIDTH, normalizedWidth));
}

export function resolveBrowserOpenRightSidePanelWidth(input: {
  currentWidth: number;
  viewportWidth: number;
}): number {
  const safeViewportWidth =
    Number.isFinite(input.viewportWidth) && input.viewportWidth > 0 ? input.viewportWidth : 0;
  const preferredBrowserWidth =
    safeViewportWidth > 0
      ? Math.max(
          DEFAULT_BROWSER_RIGHT_SIDE_PANEL_WIDTH,
          Math.round(safeViewportWidth * BROWSER_RIGHT_SIDE_PANEL_INITIAL_WIDTH_RATIO),
        )
      : DEFAULT_BROWSER_RIGHT_SIDE_PANEL_WIDTH;
  return clampRightSidePanelWidth(
    Math.max(input.currentWidth, preferredBrowserWidth),
    safeViewportWidth,
  );
}

export function constrainedPanelWidth(
  width: number,
  minimumRemainingWidth: number,
  minimumPanelWidth = 0,
): string {
  const roundedWidth = Math.round(width);
  if (minimumPanelWidth > 0) {
    return `min(100vw, clamp(${minimumPanelWidth}px, ${roundedWidth}px, calc(100vw - ${minimumRemainingWidth}px)))`;
  }
  return `min(${roundedWidth}px, calc(100vw - ${minimumRemainingWidth}px))`;
}
