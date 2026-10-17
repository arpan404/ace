import { expect, it } from "vitest";
import { z } from "zod";
import { EmbeddedPageGroup, nativeTabLimit } from "./page-group.ts";
import { TabPage } from "./test-support.ts";

function group() {
  const pages = new Map<string, TabPage>();
  const events: { method: string; params: unknown }[] = [];
  const tabs = new EmbeddedPageGroup(
    async (id) => {
      const page = new TabPage();
      pages.set(id, page);
      return page;
    },
    async () => {},
  );
  tabs.onEvent((method, params) => events.push({ method, params }));
  const panel = { window: undefined, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  return { tabs, pages, events, panel };
}

const Opened = z.object({ activeTabId: z.string(), tabId: z.string() });
const TabList = (value: unknown) => Opened.parse(value);

it("a second tab opens in the background: the panel keeps showing the selected one", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  tabs.setNativeInput(true);
  const opened = TabList(await tabs.cdp("ace.tabs.open"));
  expect(opened).toMatchObject({ activeTabId: "native-tab-1", tabId: "native-tab-2" });
  expect(pages.get("native-tab-1")).toMatchObject({ shown: true, nativeInput: true });
  expect(pages.get("native-tab-2")).toMatchObject({ shown: false, nativeInput: false });
});

it("an agent drives a background tab by id while the person's tab stays put", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  const { tabId } = TabList(await tabs.cdp("ace.tabs.open"));
  await tabs.cdp("ace.tabs.cdp", {
    tabId,
    method: "Page.navigate",
    params: { url: "https://b.test/" },
  });
  await tabs.cdp("ace.tabs.resize", { tabId, width: 1024, height: 768 });
  expect(pages.get("native-tab-2")?.url()).toBe("https://b.test/");
  expect(pages.get("native-tab-2")?.calls.at(-1)).toEqual({
    method: "resize",
    params: { width: 1024, height: 768 },
  });
  expect(pages.get("native-tab-1")?.calls).toEqual([]);
  expect(pages.get("native-tab-1")?.shown).toBe(true);
});

it("selecting a tab shows it in the panel and hides the other, which keeps its page", async () => {
  const { tabs, pages, panel, events } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  await tabs.cdp("ace.tabs.open");
  await tabs.cdp("ace.tabs.switch", { tabId: "native-tab-2" });
  expect(pages.get("native-tab-2")?.shown).toBe(true);
  expect(pages.get("native-tab-1")).toMatchObject({ shown: false, closed: false });
  expect(events.at(-1)).toMatchObject({
    method: "ace.tabs.changed",
    params: { activeTabId: "native-tab-2" },
  });
});

it("a tab opened with select becomes the shown one at once", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  await tabs.cdp("ace.tabs.open", { select: true });
  expect(pages.get("native-tab-2")?.shown).toBe(true);
  expect(pages.get("native-tab-1")?.shown).toBe(false);
});

it("closing the selected tab shows another, and the last tab cannot be closed alone", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  await tabs.cdp("ace.tabs.open", { select: true });
  await tabs.cdp("ace.tabs.close", { tabId: "native-tab-2" });
  expect(pages.get("native-tab-2")?.closed).toBe(true);
  expect(pages.get("native-tab-1")?.shown).toBe(true);
  await expect(tabs.cdp("ace.tabs.close", { tabId: "native-tab-1" })).rejects.toThrow(
    "Close the browser to close its last tab",
  );
});

it("a thread holds at most the tab limit", async () => {
  const { tabs } = group();
  for (let index = 0; index < nativeTabLimit; index++) await tabs.cdp("ace.tabs.open");
  await expect(tabs.cdp("ace.tabs.open")).rejects.toThrow("Browser tab limit");
});

it("only the selected tab's screencast reaches the daemon; a background frame is acknowledged", async () => {
  const { tabs, pages, events } = group();
  await tabs.openTab();
  await tabs.cdp("ace.tabs.open");
  pages.get("native-tab-2")?.emit("Page.screencastFrame", { sessionId: 4, data: "b" });
  pages.get("native-tab-1")?.emit("Page.screencastFrame", { sessionId: 9, data: "a" });
  expect(events.filter((event) => event.method === "Page.screencastFrame")).toEqual([
    {
      method: "Page.screencastFrame",
      params: { sessionId: 9, data: "a", aceTabId: "native-tab-1" },
    },
  ]);
  expect(pages.get("native-tab-2")?.acks()).toBe(1);
});

it("a lost link orphans every tab and an adoption hands each a fresh session", async () => {
  const { tabs, pages } = group();
  await tabs.openTab();
  await tabs.cdp("ace.tabs.open");
  tabs.orphan();
  expect([...pages.values()].map((page) => page.orphaned)).toEqual([true, true]);
  await tabs.readopt();
  expect([...pages.values()].map((page) => page.adoptions)).toEqual([1, 1]);
});

it("whether an agent uses the tab reaches only the shown tab; an unseen tab stays the agents'", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  await tabs.cdp("ace.tabs.open");
  tabs.setAgentControl(false);
  expect(pages.get("native-tab-1")?.agent).toBe(false);
  expect(pages.get("native-tab-2")?.agent).toBe(true);
  // The daemon says whether an agent uses the newly shown tab after a switch; until then the
  // last word holds.
  await tabs.cdp("ace.tabs.switch", { tabId: "native-tab-2" });
  expect(pages.get("native-tab-1")?.agent).toBe(true);
  expect(pages.get("native-tab-2")?.agent).toBe(false);
});

it("the person's input is reported with the tab it landed in, and an agent there keeps its file choosers", async () => {
  const { tabs, pages, panel } = group();
  await tabs.openTab();
  tabs.place({ ...panel, visible: true });
  tabs.setNativeInput(true);
  const heard: (string | undefined)[] = [];
  tabs.onHumanInput((tabId) => heard.push(tabId));
  pages.get("native-tab-1")?.personClicks();
  expect(heard).toEqual(["native-tab-1"]);
  // An agent using the shown tab changes nothing about the person's input.
  tabs.setAgentControl(true);
  expect(pages.get("native-tab-1")).toMatchObject({ agent: true, nativeInput: true });
  pages.get("native-tab-1")?.personClicks();
  expect(heard).toEqual(["native-tab-1", "native-tab-1"]);
});
