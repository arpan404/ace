import { describe, expect, it } from "vitest";

import {
  hasMinimumSelectionSize,
  isAbortedWebviewLoad,
  mapSelectionRectToCapturedImageCrop,
  normalizeDesignCommentToSingleLine,
  resolveElementCommentWheelForwardingMode,
  shouldRunElementHoverInspection,
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

describe("isAbortedWebviewLoad", () => {
  it("ignores Electron wrapped aborted webview navigations", () => {
    expect(
      isAbortedWebviewLoad(
        new Error(
          "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3) loading 'https://youtube.com/'",
        ),
      ),
    ).toBe(true);
  });
});

describe("mapSelectionRectToCapturedImageCrop", () => {
  it("scales overlay selections into the captured bitmap coordinate space", () => {
    expect(
      mapSelectionRectToCapturedImageCrop({
        imageHeight: 1600,
        imageWidth: 2000,
        selection: { x: 250, y: 100, width: 200, height: 160 },
        viewportHeight: 800,
        viewportWidth: 1000,
      }),
    ).toEqual({ x: 500, y: 200, width: 400, height: 320 });
  });

  it("scales down when a zoomed webview reports a smaller captured bitmap", () => {
    expect(
      mapSelectionRectToCapturedImageCrop({
        imageHeight: 400,
        imageWidth: 500,
        selection: { x: 250, y: 100, width: 200, height: 160 },
        viewportHeight: 800,
        viewportWidth: 1000,
      }),
    ).toEqual({ x: 125, y: 50, width: 100, height: 80 });
  });

  it("clamps selections to the captured bitmap", () => {
    expect(
      mapSelectionRectToCapturedImageCrop({
        imageHeight: 400,
        imageWidth: 500,
        selection: { x: 990, y: 790, width: 40, height: 40 },
        viewportHeight: 800,
        viewportWidth: 1000,
      }),
    ).toEqual({ x: 495, y: 395, width: 5, height: 5 });
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

describe("normalizeDesignCommentToSingleLine", () => {
  it("replaces line breaks with spaces so comment submissions stay one line", () => {
    expect(normalizeDesignCommentToSingleLine("Fix spacing\nfor header")).toBe(
      "Fix spacing for header",
    );
    expect(normalizeDesignCommentToSingleLine("First line\r\nSecond line")).toBe(
      "First line Second line",
    );
  });
});

describe("shouldRunElementHoverInspection", () => {
  const baseInput = {
    active: true,
    designerModeActive: true,
    designerTool: "element-comment" as const,
    hasDesignDraft: false,
    requestInFlight: false,
  };

  it("allows hover inspection only for the active element-comment tab", () => {
    expect(shouldRunElementHoverInspection(baseInput)).toBe(true);
    expect(shouldRunElementHoverInspection({ ...baseInput, active: false })).toBe(false);
    expect(
      shouldRunElementHoverInspection({
        ...baseInput,
        designerTool: "area-comment",
      }),
    ).toBe(false);
  });

  it("skips hover inspection while a draft or request is active", () => {
    expect(shouldRunElementHoverInspection({ ...baseInput, hasDesignDraft: true })).toBe(false);
    expect(shouldRunElementHoverInspection({ ...baseInput, requestInFlight: true })).toBe(false);
  });
});

describe("resolveElementCommentWheelForwardingMode", () => {
  it("uses DOM scroll forwarding on macOS so wheel deltas match normal browser scrolling", () => {
    expect(
      resolveElementCommentWheelForwardingMode({
        hasSendInputEvent: true,
        platform: "MacIntel",
      }),
    ).toBe("dom-scroll");
  });

  it("keeps Electron input forwarding on non-macOS webviews", () => {
    expect(
      resolveElementCommentWheelForwardingMode({
        hasSendInputEvent: true,
        platform: "Win32",
      }),
    ).toBe("electron-input");
    expect(
      resolveElementCommentWheelForwardingMode({
        hasSendInputEvent: true,
        platform: "Linux x86_64",
      }),
    ).toBe("electron-input");
  });

  it("falls back to DOM scroll forwarding when native input replay is unavailable", () => {
    expect(
      resolveElementCommentWheelForwardingMode({
        hasSendInputEvent: false,
        platform: "Win32",
      }),
    ).toBe("dom-scroll");
  });
});
