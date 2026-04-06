import { describe, expect, it, vi } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  isScrollContainerNearBottom,
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
