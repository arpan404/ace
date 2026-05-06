import { describe, expect, it } from "vitest";

import { resolveMountedBrowserTabs } from "./InAppBrowser";

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
        tabs,
      }).map((tab) => tab.id),
    ).toEqual(["tab-a", "tab-c"]);
  });

  it("does not mount internal browser tabs", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-new",
        lastActiveTabId: "tab-b",
        tabs: [{ id: "tab-new", title: "New tab", url: "ace://browser/new-tab" }, ...tabs],
      }).map((tab) => tab.id),
    ).toEqual(["tab-b"]);
  });

  it("falls back to only the active tab before tab switching has happened", () => {
    expect(
      resolveMountedBrowserTabs({
        activeTabId: "tab-b",
        lastActiveTabId: null,
        tabs,
      }).map((tab) => tab.id),
    ).toEqual(["tab-b"]);
  });
});
