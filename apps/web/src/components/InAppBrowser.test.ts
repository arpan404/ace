import { describe, expect, it } from "vitest";

import { resolveMountedBrowserTabs, shouldPublishBrowserSessionChange } from "./InAppBrowser";

describe("resolveMountedBrowserTabs", () => {
  const tabs = [
    { id: "tab-a", title: "A", url: "https://a.example/" },
    { id: "tab-b", title: "B", url: "https://b.example/" },
    { id: "tab-c", title: "C", url: "https://c.example/" },
  ];

  it("keeps only the active and last active webview tabs mounted", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-c",
        lastActiveTabId: "tab-a",
        retainLastActiveTab: true,
        tabs,
      }).map((tab) => tab.id),
    ).toEqual(["tab-a", "tab-c"]);
  });

  it("does not mount internal browser tabs", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-new",
        lastActiveTabId: "tab-b",
        retainLastActiveTab: true,
        tabs: [{ id: "tab-new", title: "New tab", url: "ace://browser/new-tab" }, ...tabs],
      }).map((tab) => tab.id),
    ).toEqual(["tab-b"]);
  });

  it("falls back to only the active tab before tab switching has happened", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-b",
        lastActiveTabId: null,
        retainLastActiveTab: true,
        tabs,
      }).map((tab) => tab.id),
    ).toEqual(["tab-b"]);
  });

  it("keeps only the active webview tab for retained hidden browser instances", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-c",
        lastActiveTabId: "tab-a",
        retainLastActiveTab: false,
        tabs,
      }).map((tab) => tab.id),
    ).toEqual(["tab-c"]);
  });
});

describe("shouldPublishBrowserSessionChange", () => {
  const previous = {
    activeTabId: "tab-a",
    panelHeight: 600,
    tabs: [
      { id: "tab-a", title: "A", url: "https://a.example/" },
      { id: "tab-b", title: "B", url: "https://b.example/" },
    ],
  };

  it("publishes all visible browser session changes", () => {
    expect(
      shouldPublishBrowserSessionChange({
        previous,
        next: { ...previous, panelHeight: 720 },
        visible: true,
      }),
    ).toBe(true);
  });

  it("ignores hidden browser updates that do not affect tab strip state", () => {
    expect(
      shouldPublishBrowserSessionChange({
        previous,
        next: { ...previous, panelHeight: 720 },
        visible: false,
      }),
    ).toBe(false);
  });

  it("publishes hidden browser changes when tab state changes", () => {
    expect(
      shouldPublishBrowserSessionChange({
        previous,
        next: { ...previous, activeTabId: "tab-b" },
        visible: false,
      }),
    ).toBe(true);
  });
});
