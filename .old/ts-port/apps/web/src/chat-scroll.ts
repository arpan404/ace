export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
export const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX = 160;
const AUTO_SCROLL_DISABLE_UP_DELTA_PX = 1;

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

export function shouldShowScrollToBottomButton(position: ScrollPosition): boolean {
  return !isScrollContainerNearBottom(position, SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX);
}

export function hasScrolledUp(currentScrollTop: number, previousScrollTop: number): boolean {
  return currentScrollTop < previousScrollTop - AUTO_SCROLL_DISABLE_UP_DELTA_PX;
}

export interface AutoScrollOnScrollInput {
  shouldAutoScroll: boolean;
  isNearBottom: boolean;
  currentScrollTop: number;
  previousScrollTop: number;
  hasPendingUserScrollUpIntent: boolean;
  isPointerScrollActive: boolean;
}

export interface AutoScrollOnScrollDecision {
  shouldAutoScroll: boolean;
  clearPendingUserScrollUpIntent: boolean;
  cancelPendingStickToBottom: boolean;
  scheduleStickToBottom: boolean;
}

export function resolveAutoScrollOnScroll(
  input: AutoScrollOnScrollInput,
): AutoScrollOnScrollDecision {
  if (!input.shouldAutoScroll) {
    if (input.hasPendingUserScrollUpIntent || input.isPointerScrollActive) {
      return {
        shouldAutoScroll: false,
        clearPendingUserScrollUpIntent: !input.isNearBottom,
        cancelPendingStickToBottom: true,
        scheduleStickToBottom: false,
      };
    }
    if (input.isNearBottom) {
      return {
        shouldAutoScroll: true,
        clearPendingUserScrollUpIntent: true,
        cancelPendingStickToBottom: false,
        scheduleStickToBottom: false,
      };
    }
    return {
      shouldAutoScroll: false,
      clearPendingUserScrollUpIntent: false,
      cancelPendingStickToBottom: false,
      scheduleStickToBottom: false,
    };
  }

  const scrolledUp = hasScrolledUp(input.currentScrollTop, input.previousScrollTop);
  const hasExplicitScrollUpIntent =
    input.hasPendingUserScrollUpIntent || input.isPointerScrollActive;
  if (scrolledUp) {
    return {
      shouldAutoScroll: false,
      clearPendingUserScrollUpIntent: true,
      cancelPendingStickToBottom: true,
      scheduleStickToBottom: false,
    };
  }

  return {
    shouldAutoScroll: true,
    clearPendingUserScrollUpIntent: true,
    cancelPendingStickToBottom: false,
    scheduleStickToBottom: !input.isNearBottom && !hasExplicitScrollUpIntent,
  };
}
