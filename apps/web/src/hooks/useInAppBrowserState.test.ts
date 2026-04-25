import { describe, expect, it } from "vitest";

import {
  resolveBrowserSuggestionDraftValue,
  resolveNextBrowserSuggestionIndex,
  shouldAutoFocusBrowserAddressBarOnOpen,
} from "./useInAppBrowserState";

describe("shouldAutoFocusBrowserAddressBarOnOpen", () => {
  it("only auto-focuses for a single fresh new-tab session", () => {
    expect(
      shouldAutoFocusBrowserAddressBarOnOpen({
        activeTabIsNewTab: true,
        browserTabCount: 1,
      }),
    ).toBe(true);

    expect(
      shouldAutoFocusBrowserAddressBarOnOpen({
        activeTabIsNewTab: false,
        browserTabCount: 1,
      }),
    ).toBe(false);

    expect(
      shouldAutoFocusBrowserAddressBarOnOpen({
        activeTabIsNewTab: true,
        browserTabCount: 2,
      }),
    ).toBe(false);
  });
});

describe("resolveBrowserSuggestionDraftValue", () => {
  it("uses the actual URL for navigational suggestions", () => {
    expect(
      resolveBrowserSuggestionDraftValue({
        id: "history:https://example.com/docs",
        kind: "history",
        subtitle: "https://example.com/docs",
        title: "Example Docs",
        url: "https://example.com/docs",
      }),
    ).toBe("https://example.com/docs");
  });

  it("keeps raw query text for search suggestions", () => {
    expect(
      resolveBrowserSuggestionDraftValue({
        id: "search:vitest browser",
        kind: "search",
        subtitle: "Search Google",
        title: "vitest browser",
        url: "https://www.google.com/search?q=vitest%20browser",
      }),
    ).toBe("vitest browser");
  });
});

describe("resolveNextBrowserSuggestionIndex", () => {
  it("keeps suggestions unselected until keyboard navigation starts", () => {
    expect(resolveNextBrowserSuggestionIndex(-1, 3, 1)).toBe(0);
    expect(resolveNextBrowserSuggestionIndex(-1, 3, -1)).toBe(2);
  });

  it("clamps keyboard navigation inside the suggestion list", () => {
    expect(resolveNextBrowserSuggestionIndex(0, 3, -1)).toBe(0);
    expect(resolveNextBrowserSuggestionIndex(1, 3, 1)).toBe(2);
    expect(resolveNextBrowserSuggestionIndex(2, 3, 1)).toBe(2);
  });

  it("returns no selection when there are no suggestions", () => {
    expect(resolveNextBrowserSuggestionIndex(0, 0, 1)).toBe(-1);
  });
});
