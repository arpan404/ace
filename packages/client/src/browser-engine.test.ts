import { describe, expect, it } from "vitest";
import type { ClientApi } from "./api.ts";
import { keepBrowserEngine, moveBrowserEngine } from "./browser-engine.ts";

const ok = (result: unknown) => ({ ok: true as const, result });
const fail = (error: string) => ({ ok: false as const, error });

type Tab = { tabId: string; url: string; private?: boolean };

/**
 * A daemon with one thread's browser: its engine, tabs and shown tab, the thread's engine
 * setting, pages that refuse to load (`broken`), whether a desktop app is there to host
 * `embedded` pages, and whether the daemon says so in its states (`reports`).
 */
function daemon(start: {
  backend: string;
  tabs: Tab[];
  activeTabId: string;
  broken?: string[];
  desktop?: boolean;
  reports?: boolean;
}) {
  const desktop = start.desktop ?? true;
  let backend = start.backend;
  let tabs = start.tabs;
  let active: string | undefined = start.activeTabId;
  let closed = false;
  let next = 0;
  const setting: { value?: unknown; layer?: unknown } = { value: "auto" };
  let closes = 0;
  const state = () => ({
    threadId: "thread-1",
    url: tabs.find((tab) => tab.tabId === active)?.url ?? "about:blank",
    closed,
    backend,
    tabs: tabs.map((tab) => ({ ...tab, title: "" })),
    activeTabId: active,
    ...(start.reports ? { features: ["engines", ...(desktop ? ["embedded-engine"] : [])] } : {}),
  });
  const request = async (input: Record<string, unknown>) => {
    switch (input.type) {
      case "settings.set":
        setting.value = input.value;
        setting.layer = input.layer;
        return { ok: true, diagnostics: [] };
      case "settings.get":
        return {
          ok: true,
          diagnostics: [],
          entries: [{ key: "browser.backend", value: setting.value, provenance: "thread" }],
        };
      case "browser.open":
        if (closed) {
          const preference = String(setting.value);
          if (preference === "embedded" && !desktop)
            return fail("Desktop browser backend unavailable");
          closed = false;
          backend = preference === "auto" ? (desktop ? "embedded" : "headless") : preference;
          tabs = [{ tabId: `t${++next}`, url: "about:blank" }];
          active = tabs[0]?.tabId;
        }
        return ok(state());
      case "browser.close":
        closes++;
        closed = true;
        tabs = [];
        active = undefined;
        return ok({});
      case "browser.execute": {
        const command = input.command as { action: string; url: string; tabId: string };
        if (start.broken?.includes(command.url)) return fail("net::ERR_CONNECTION_REFUSED");
        tabs = tabs.map((tab) =>
          tab.tabId === command.tabId ? { ...tab, url: command.url } : tab,
        );
        return ok({});
      }
      case "browser.tabs.open": {
        const url = String(input.url);
        if (start.broken?.includes(url)) return fail("net::ERR_CONNECTION_REFUSED");
        const tabId = `t${++next}`;
        tabs = [...tabs, { tabId, url }];
        active = tabId;
        return ok({ tabId, activeTabId: tabId, tabs: state().tabs });
      }
      case "browser.tabs.select":
        active = String(input.tabId);
        return ok({ activeTabId: active, tabs: state().tabs });
      case "browser.tabs.private":
        tabs = tabs.map((tab) =>
          tab.tabId === input.tabId ? { ...tab, private: Boolean(input.private) } : tab,
        );
        return ok(state());
      default:
        return fail("unknown");
    }
  };
  return {
    client: { request } as unknown as Pick<ClientApi, "request">,
    get backend() {
      return backend;
    },
    get setting() {
      return setting;
    },
    get closes() {
      return closes;
    },
    get shown() {
      return tabs.find((tab) => tab.tabId === active);
    },
    get tabs() {
      return tabs;
    },
  };
}

const input = { threadId: "thread-1", workspaceId: "workspace-1" };

describe("switching a thread's browser engine", () => {
  it("keeps the choice for the thread alone when it has no browser yet", async () => {
    const machine = daemon({ backend: "embedded", tabs: [], activeTabId: "" });
    await keepBrowserEngine(machine.client, { ...input, engine: "headless" });
    expect(machine.setting).toEqual({
      value: "headless",
      layer: { kind: "thread", threadId: "thread-1" },
    });
  });

  it("reloads every web page on the new engine with the same tab still shown", async () => {
    const machine = daemon({
      backend: "embedded",
      tabs: [
        { tabId: "a", url: "https://one.example/" },
        { tabId: "b", url: "https://two.example/", private: true },
        { tabId: "c", url: "about:blank" },
      ],
      activeTabId: "b",
    });
    const moved = await moveBrowserEngine(machine.client, { ...input, engine: "headless" });
    expect(machine.backend).toBe("headless");
    expect(machine.tabs.map((tab) => tab.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
    ]);
    expect(machine.shown).toMatchObject({ url: "https://two.example/", private: true });
    expect(moved.activeTabId).toBe(machine.shown?.tabId);
  });

  it("leaves a browser already on the engine alone", async () => {
    const machine = daemon({
      backend: "headless",
      tabs: [{ tabId: "a", url: "https://one.example/" }],
      activeTabId: "a",
    });
    const moved = await moveBrowserEngine(machine.client, { ...input, engine: "headless" });
    expect(moved.activeTabId).toBe("a");
    expect(machine.tabs).toEqual([{ tabId: "a", url: "https://one.example/" }]);
  });

  it("refuses the desktop app's engine when the machine has none, before closing anything", async () => {
    const pages = [
      { tabId: "a", url: "https://one.example/" },
      { tabId: "b", url: "https://two.example/" },
    ];
    const machine = daemon({
      backend: "headless",
      tabs: pages,
      activeTabId: "b",
      desktop: false,
      reports: true,
    });
    await expect(
      moveBrowserEngine(machine.client, { ...input, engine: "embedded" }),
    ).rejects.toThrow(/desktop app isn't running/);
    expect(machine.closes).toBe(0);
    expect(machine.setting.value).toBe("auto");
    expect(machine.tabs).toEqual(pages);
    expect(machine.shown?.tabId).toBe("b");
  });

  it("puts the engine and pages back when the new engine won't open", async () => {
    // A daemon that doesn't say which engines can open: the move is tried, then undone.
    const machine = daemon({
      backend: "headless",
      tabs: [
        { tabId: "a", url: "https://one.example/" },
        { tabId: "b", url: "https://two.example/", private: true },
      ],
      activeTabId: "b",
      desktop: false,
    });
    await expect(
      moveBrowserEngine(machine.client, { ...input, engine: "embedded" }),
    ).rejects.toThrow(/stayed where it was\. Desktop browser backend unavailable/);
    expect(machine.setting.value).toBe("auto");
    expect(machine.backend).toBe("headless");
    expect(machine.tabs.map((tab) => tab.url)).toEqual([
      "https://one.example/",
      "https://two.example/",
    ]);
    expect(machine.shown).toMatchObject({ url: "https://two.example/", private: true });
  });

  it("names the pages that didn't reload once the rest have moved", async () => {
    const machine = daemon({
      backend: "embedded",
      tabs: [
        { tabId: "a", url: "https://one.example/" },
        { tabId: "b", url: "https://down.example/" },
      ],
      activeTabId: "a",
      broken: ["https://down.example/"],
    });
    await expect(
      moveBrowserEngine(machine.client, { ...input, engine: "headless" }),
    ).rejects.toThrow(/this tab didn't reload: https:\/\/down\.example\//);
    expect(machine.backend).toBe("headless");
    expect(machine.shown?.url).toBe("https://one.example/");
  });
});
