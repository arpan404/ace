import { describe, expect, it, vi } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  isScrollContainerNearBottom,
  resolveAutoScrollOnScroll,
  resolveTimelinePrependScrollAnchor,
  shouldPreserveInteractionAnchorOnClick,
  scrollContainerToBottom,
} from "./chat-scroll";

describe("isScrollContainerNearBottom", () => {
  it("returns true when already at bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 600,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns true when within the auto-scroll threshold", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 540,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false when the user is meaningfully above the bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("clamps negative thresholds to zero", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 539,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        -1,
      ),
    ).toBe(false);
  });

  it("falls back to the default threshold for non-finite values", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 540,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        Number.NaN,
      ),
    ).toBe(true);
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(64);
  });
});

describe("scrollContainerToBottom", () => {
  it("jumps directly to the bottom by default", () => {
    const scrollTo = vi.fn();
    const scrollContainer = {
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTo,
    };

    scrollContainerToBottom(scrollContainer);

    expect(scrollContainer.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps smooth scrolling opt-in", () => {
    const scrollTo = vi.fn();
    const scrollContainer = {
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTo,
    };

    scrollContainerToBottom(scrollContainer, "smooth");

    expect(scrollContainer.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "smooth" });
  });
});

describe("resolveAutoScrollOnScroll", () => {
  it("re-enables auto-scroll once the user returns near bottom", () => {
    expect(
      resolveAutoScrollOnScroll({
        shouldAutoScroll: false,
        isNearBottom: true,
        currentScrollTop: 540,
        previousScrollTop: 560,
        hasPendingUserScrollUpIntent: true,
        isPointerScrollActive: false,
      }),
    ).toEqual({
      shouldAutoScroll: true,
      clearPendingUserScrollUpIntent: true,
      cancelPendingStickToBottom: false,
      scheduleStickToBottom: false,
    });
  });

  it("disables auto-scroll when explicit user scroll-up intent moves upward", () => {
    expect(
      resolveAutoScrollOnScroll({
        shouldAutoScroll: true,
        isNearBottom: false,
        currentScrollTop: 500,
        previousScrollTop: 540,
        hasPendingUserScrollUpIntent: true,
        isPointerScrollActive: false,
      }),
    ).toEqual({
      shouldAutoScroll: false,
      clearPendingUserScrollUpIntent: true,
      cancelPendingStickToBottom: true,
      scheduleStickToBottom: false,
    });
  });

  it("keeps auto-scroll active for layout drift without explicit user intent", () => {
    expect(
      resolveAutoScrollOnScroll({
        shouldAutoScroll: true,
        isNearBottom: false,
        currentScrollTop: 520,
        previousScrollTop: 540,
        hasPendingUserScrollUpIntent: false,
        isPointerScrollActive: false,
      }),
    ).toEqual({
      shouldAutoScroll: true,
      clearPendingUserScrollUpIntent: true,
      cancelPendingStickToBottom: false,
      scheduleStickToBottom: true,
    });
  });

  it("does not force stick-to-bottom while pointer scrolling is active", () => {
    expect(
      resolveAutoScrollOnScroll({
        shouldAutoScroll: true,
        isNearBottom: false,
        currentScrollTop: 540,
        previousScrollTop: 540,
        hasPendingUserScrollUpIntent: false,
        isPointerScrollActive: true,
      }),
    ).toEqual({
      shouldAutoScroll: true,
      clearPendingUserScrollUpIntent: true,
      cancelPendingStickToBottom: false,
      scheduleStickToBottom: false,
    });
  });
});

describe("resolveTimelinePrependScrollAnchor", () => {
  it("preserves the viewport anchor when older timeline rows are prepended", () => {
    expect(
      resolveTimelinePrependScrollAnchor({
        previousThreadId: "thread-1",
        currentThreadId: "thread-1",
        previousEntryCount: 4,
        currentEntryCount: 8,
        previousFirstEntryKey: "message:older-loaded",
        currentFirstEntryKey: "message:first-loaded",
        previousLastEntryKey: "message:latest",
        currentLastEntryKey: "message:latest",
        previousScrollHeight: 1_000,
        currentScrollHeight: 1_460,
        previousScrollTop: 320,
        shouldAutoScroll: false,
      }),
    ).toEqual({ kind: "preserve-anchor", scrollTop: 780 });
  });

  it("sticks to bottom when older timeline rows prepend while auto-scroll is active", () => {
    expect(
      resolveTimelinePrependScrollAnchor({
        previousThreadId: "thread-1",
        currentThreadId: "thread-1",
        previousEntryCount: 4,
        currentEntryCount: 8,
        previousFirstEntryKey: "message:older-loaded",
        currentFirstEntryKey: "message:first-loaded",
        previousLastEntryKey: "message:latest",
        currentLastEntryKey: "message:latest",
        previousScrollHeight: 1_000,
        currentScrollHeight: 1_460,
        previousScrollTop: 320,
        shouldAutoScroll: true,
      }),
    ).toEqual({ kind: "stick-to-bottom" });
  });

  it("does nothing when newer timeline rows are appended", () => {
    expect(
      resolveTimelinePrependScrollAnchor({
        previousThreadId: "thread-1",
        currentThreadId: "thread-1",
        previousEntryCount: 4,
        currentEntryCount: 5,
        previousFirstEntryKey: "message:first-loaded",
        currentFirstEntryKey: "message:first-loaded",
        previousLastEntryKey: "message:latest",
        currentLastEntryKey: "message:new-latest",
        previousScrollHeight: 1_000,
        currentScrollHeight: 1_140,
        previousScrollTop: 320,
        shouldAutoScroll: false,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("shouldPreserveInteractionAnchorOnClick", () => {
  it("keeps anchor preservation for keyboard-triggered clicks", () => {
    expect(shouldPreserveInteractionAnchorOnClick(0)).toBe(true);
  });

  it("skips anchor preservation for pointer clicks", () => {
    expect(shouldPreserveInteractionAnchorOnClick(1)).toBe(false);
  });
});
