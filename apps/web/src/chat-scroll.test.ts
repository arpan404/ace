import { describe, expect, it } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  clampScrollTop,
  isScrollContainerNearBottom,
  resolveThreadOpenScrollBehavior,
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

describe("clampScrollTop", () => {
  it("keeps scrollTop within the visible scroll range", () => {
    expect(clampScrollTop(120, { clientHeight: 400, scrollHeight: 1_000 })).toBe(120);
    expect(clampScrollTop(800, { clientHeight: 400, scrollHeight: 1_000 })).toBe(600);
    expect(clampScrollTop(-10, { clientHeight: 400, scrollHeight: 1_000 })).toBe(0);
  });
});

describe("resolveThreadOpenScrollBehavior", () => {
  it("restores saved scroll for threads opened earlier in this session", () => {
    expect(
      resolveThreadOpenScrollBehavior({
        hasSavedScrollSnapshot: true,
        hasOpenedAnyThreadInSession: true,
      }),
    ).toBe("restore-saved");
  });

  it("preserves current position for the first thread opened after app start", () => {
    expect(
      resolveThreadOpenScrollBehavior({
        hasSavedScrollSnapshot: false,
        hasOpenedAnyThreadInSession: false,
      }),
    ).toBe("preserve-current");
  });

  it("sticks to bottom for newly opened threads after the session is already warm", () => {
    expect(
      resolveThreadOpenScrollBehavior({
        hasSavedScrollSnapshot: false,
        hasOpenedAnyThreadInSession: true,
      }),
    ).toBe("stick-to-bottom");
  });
});
