import { describe, expect, it } from "vitest";
import type { BrowserView } from "../sources.ts";
import { clampPip, pipPage } from "./pip-rules.ts";

const view = (tab: Partial<NonNullable<BrowserView["tabs"]>[number]> = {}): BrowserView => ({
  threadId: "t",
  url: "https://app.test/",
  closed: false,
  activeTabId: "a",
  tabs: [{ tabId: "a", url: "https://app.test/", title: "App", ...tab }],
});
const agent = { kind: "agent" as const, agentId: "worker" };

describe("picture-in-picture", () => {
  it("floats the shown page while an agent browses and the Browser is out of sight", () => {
    expect(
      pipPage({
        view: view({ inUse: agent }),
        showingBrowser: false,
        dismissed: false,
        enabled: true,
      }),
    ).toMatchObject({ tabId: "a", title: "App" });
  });
  it("floats a page playing sound with no agent at work", () => {
    expect(
      pipPage({
        view: view({ playing: true }),
        showingBrowser: false,
        dismissed: false,
        enabled: true,
      }),
    ).toMatchObject({ tabId: "a" });
  });
  it("stays away while the Browser shows, once dismissed, for a quiet or blank page", () => {
    const busy = view({ inUse: agent });
    expect(
      pipPage({ view: busy, showingBrowser: true, dismissed: false, enabled: true }),
    ).toBeUndefined();
    expect(
      pipPage({ view: busy, showingBrowser: false, dismissed: true, enabled: true }),
    ).toBeUndefined();
    expect(
      pipPage({ view: view(), showingBrowser: false, dismissed: false, enabled: true }),
    ).toBeUndefined();
    expect(
      pipPage({
        view: view({ inUse: agent, url: "about:blank" }),
        showingBrowser: false,
        dismissed: false,
        enabled: true,
      }),
    ).toBeUndefined();
  });
  it("never floats a page while picture-in-picture is turned off", () => {
    for (const tab of [{ inUse: agent }, { playing: true }])
      expect(
        pipPage({ view: view(tab), showingBrowser: false, dismissed: false, enabled: false }),
      ).toBeUndefined();
  });
  it("keeps the floating window inside the app window at a usable size", () => {
    const window = { width: 1200, height: 800 };
    expect(clampPip({ right: -50, bottom: 5000, width: 100 }, window, 0.625)).toEqual({
      right: 8,
      bottom: 800 - (240 * 0.625 + 28) - 8,
      width: 240,
    });
    expect(clampPip({ right: 16, bottom: 16, width: 5000 }, window, 0.625).width).toBe(600);
  });
});
