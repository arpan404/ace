export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;

export type ThreadOpenScrollBehavior = "restore-saved" | "preserve-current" | "stick-to-bottom";

interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function clampScrollTop(
  scrollTop: number,
  position: Pick<ScrollPosition, "clientHeight" | "scrollHeight">,
): number {
  const resolvedScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const maxScrollTop = Math.max(0, position.scrollHeight - position.clientHeight);
  return Math.min(resolvedScrollTop, maxScrollTop);
}

export function resolveThreadOpenScrollBehavior(input: {
  hasSavedScrollSnapshot: boolean;
  hasOpenedAnyThreadInSession: boolean;
}): ThreadOpenScrollBehavior {
  if (input.hasSavedScrollSnapshot) {
    return "restore-saved";
  }
  return input.hasOpenedAnyThreadInSession ? "stick-to-bottom" : "preserve-current";
}

export function isScrollContainerNearBottom(
  position: ScrollPosition,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }

  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}
