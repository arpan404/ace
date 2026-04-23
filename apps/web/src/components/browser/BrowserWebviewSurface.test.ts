import { describe, expect, it } from "vitest";

import {
  hasMinimumSelectionSize,
  shouldSubmitDesignDraftFromTextareaKey,
} from "./BrowserWebviewSurface";

describe("hasMinimumSelectionSize", () => {
  it("keeps area captures at the default 24px minimum", () => {
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 80, height: 23 })).toBe(false);
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 24, height: 24 })).toBe(true);
  });

  it("allows smaller element-comment targets with the element minimum", () => {
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 120, height: 18 }, 8)).toBe(true);
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 7, height: 18 }, 8)).toBe(false);
  });
});

describe("shouldSubmitDesignDraftFromTextareaKey", () => {
  it("submits comment drafts with Enter", () => {
    expect(
      shouldSubmitDesignDraftFromTextareaKey({
        altKey: false,
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("keeps Shift+Enter available for new lines", () => {
    expect(
      shouldSubmitDesignDraftFromTextareaKey({
        altKey: false,
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it("ignores modified or composing Enter presses", () => {
    expect(
      shouldSubmitDesignDraftFromTextareaKey({
        altKey: false,
        ctrlKey: false,
        isComposing: true,
        key: "Enter",
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitDesignDraftFromTextareaKey({
        altKey: false,
        ctrlKey: true,
        key: "Enter",
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});
