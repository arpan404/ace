export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;

interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

interface ScrollableContainer extends ScrollPosition {
  scrollTo(options: ScrollToOptions): void;
}

export function scrollContainerToBottom(
  scrollContainer: ScrollableContainer,
  behavior: ScrollBehavior = "auto",
): void {
  const top = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  if (behavior === "smooth") {
    scrollContainer.scrollTo({ top, behavior });
    return;
  }

  scrollContainer.scrollTop = top;
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
