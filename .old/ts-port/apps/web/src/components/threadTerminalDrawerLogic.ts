import type { ThreadTerminalGroup } from "../types";

const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

export function terminalFitSignature(input: {
  width: number;
  height: number;
  cols: number;
  rows: number;
}): `${number}x${number}:${number}x${number}` {
  return `${input.width}x${input.height}:${input.cols}x${input.rows}`;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

export function resolveTerminalTabDropTarget(
  terminalGroups: ReadonlyArray<ThreadTerminalGroup>,
  overTerminalId: string,
): { groupId: string; index: number } | null {
  for (const group of terminalGroups) {
    for (const [index, terminalId] of group.terminalIds.entries()) {
      if (terminalId === overTerminalId) {
        return { groupId: group.id, index };
      }
    }
  }
  return null;
}

export function resolveTerminalGroupPaneRatios(
  ratios: readonly number[] | undefined,
  paneCount: number,
): number[] {
  if (paneCount <= 0) return [];
  if (!ratios || ratios.length !== paneCount) {
    return Array.from({ length: paneCount }, () => 1 / paneCount);
  }
  const sanitizedRatios = ratios.map((ratio) => (Number.isFinite(ratio) && ratio > 0 ? ratio : 0));
  const total = sanitizedRatios.reduce((sum, ratio) => sum + ratio, 0);
  if (total <= 0) {
    return Array.from({ length: paneCount }, () => 1 / paneCount);
  }
  return sanitizedRatios.map((ratio) => ratio / total);
}
