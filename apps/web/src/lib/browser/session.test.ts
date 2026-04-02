import { describe, expect, it } from "vitest";

import {
  BROWSER_SETTINGS_TAB_URL,
  DEFAULT_BROWSER_PANEL_HEIGHT,
  addBrowserTab,
  clampBrowserPanelHeight,
  closeBrowserTab,
  createBrowserSessionState,
  createBrowserSettingsTab,
  isBrowserSettingsTabUrl,
  normalizeBrowserSessionState,
  resolveBrowserTabTitle,
  updateBrowserTab,
} from "./session";

describe("browser session", () => {
  it("creates a single initial tab", () => {
    const state = createBrowserSessionState("https://example.com/");

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(state.panelHeight).toBe(DEFAULT_BROWSER_PANEL_HEIGHT);
  });

  it("adds a new active tab by default", () => {
    const state = addBrowserTab(createBrowserSessionState(), {
      url: "https://openai.com/",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
    expect(state.tabs[1]?.url).toBe("https://openai.com/");
  });

  it("updates tab title and url", () => {
    const state = createBrowserSessionState();
    const tabId = state.tabs[0]!.id;

    const updated = updateBrowserTab(state, tabId, {
      title: "Docs",
      url: "https://example.com/docs",
    });

    expect(updated.tabs[0]).toEqual({
      id: tabId,
      title: "Docs",
      url: "https://example.com/docs",
    });
  });

  it("closes the active tab and selects the previous one", () => {
    const initial = createBrowserSessionState("https://example.com/");
    const next = addBrowserTab(initial, { url: "https://openai.com/" });

    const closed = closeBrowserTab(next, next.activeTabId, "https://example.com/");

    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).toBe(closed.tabs[0]?.id);
    expect(closed.tabs[0]?.url).toBe("https://example.com/");
  });

  it("normalizes duplicate or invalid tabs", () => {
    const duplicated = createBrowserSessionState("https://example.com/");
    const normalized = normalizeBrowserSessionState(
      {
        activeTabId: "missing",
        panelHeight: 9999,
        tabs: [duplicated.tabs[0]!, duplicated.tabs[0]!, { id: "", title: "", url: "" }],
      },
      "https://example.com/",
      800,
    );

    expect(normalized.tabs).toHaveLength(1);
    expect(normalized.activeTabId).toBe(normalized.tabs[0]?.id);
    expect(normalized.panelHeight).toBe(clampBrowserPanelHeight(9999, 800));
  });

  it("creates a dedicated browser settings tab", () => {
    const tab = createBrowserSettingsTab("settings-tab");

    expect(tab).toEqual({
      id: "settings-tab",
      title: "Browser settings",
      url: BROWSER_SETTINGS_TAB_URL,
    });
    expect(isBrowserSettingsTabUrl(tab.url)).toBe(true);
    expect(resolveBrowserTabTitle(tab.url)).toBe("Browser settings");
  });
});
