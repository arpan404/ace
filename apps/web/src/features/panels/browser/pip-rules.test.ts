import { describe, expect, it } from "vitest";
import type { BrowserView } from "../sources.ts";
import { floatingCandidates } from "./floating-state.ts";
import { clampPip, pipPage, placePip } from "./pip-rules.ts";

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
  it("starts a new window where no open one is: up the stack, then the next column", () => {
    const window = { width: 1200, height: 800 };
    const base = { right: 16, bottom: 16, width: 320 };
    const height = 320 * 0.625 + 28;
    const at = (geometry: { right: number; bottom: number; width: number }) => ({
      ...geometry,
      height,
    });
    const first = placePip(base, [], window, 0.625);
    expect(first).toEqual(base);
    const second = placePip(base, [at(first)], window, 0.625);
    expect(second).toEqual({ ...base, bottom: 16 + height + 8 });
    // A column holds three; the fourth starts the next column to the left.
    const third = placePip(base, [at(first), at(second)], window, 0.625);
    const fourth = placePip(base, [at(first), at(second), at(third)], window, 0.625);
    expect(fourth).toEqual({ ...base, right: 16 + 320 + 8 });
    // A window the person moved away frees its place.
    expect(placePip(base, [at({ ...first, right: 600 })], window, 0.625)).toEqual(base);
  });
});

describe("which threads float", () => {
  const input = {
    current: "open",
    seen: new Set(["open", "a", "b", "c"]),
    onScreen: new Set<string>(),
    dismissed: new Set<string>(),
    browsing: new Set(["a", "b"]),
    enabled: true,
    phone: false,
  };
  it("every looked-at thread an agent browses in, and the open thread, in the order seen", () => {
    expect(floatingCandidates(input)).toEqual(["open", "a", "b"]);
    // Never a thread whose Browser the person hasn't looked at.
    expect(floatingCandidates({ ...input, browsing: new Set(["a", "never"]) })).toEqual([
      "open",
      "a",
    ]);
  });
  it("not one whose Browser is on screen, or whose window was closed", () => {
    expect(
      floatingCandidates({ ...input, onScreen: new Set(["open"]), dismissed: new Set(["a"]) }),
    ).toEqual(["b"]);
  });
  it("none on a phone or with picture in picture turned off", () => {
    expect(floatingCandidates({ ...input, phone: true })).toEqual([]);
    expect(floatingCandidates({ ...input, enabled: false })).toEqual([]);
  });
});
