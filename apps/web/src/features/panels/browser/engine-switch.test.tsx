import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const thread = "thread-cold-start";
const first = "https://example.com/a";
const second = "https://example.com/b";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "ace");
});

/** The desktop app's embedded-browser bridge, as the page sees it. */
function desktopBridge() {
  Reflect.set(globalThis, "ace", {
    browser: {
      place: async () => true,
      snapshot: async () => undefined,
    },
  });
}

/** The thread's Browser open in the side panel, with two tabs, the second shown. */
async function openTwoTabs(options: { desktop?: boolean } = {}) {
  if (options.desktop !== false) desktopBridge();
  const app = harness();
  const scenario = coldStartReplay();
  const script = app.play(scenario);
  script.step();
  seedPanels(app.daemon);
  const browser = app.daemon.browser;
  // In the desktop app the agent's page runs in the app's own embedded browser.
  browser.drive(thread, { url: first, backend: "embedded" });
  browser.personOpen(thread, second);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  // The person picks the tab to work in; the daemon follows the shown tab.
  const strip = within(panel).getByRole("tablist", { name: "Thread panel tabs" });
  const pages = within(strip).getAllByRole("tab", { name: "Fixture page" });
  await userEvent.click(pages[pages.length - 1] as HTMLElement);
  await within(panel).findByRole("button", { name: "Browser options" });
  return { app, panel, browser };
}

async function engineMenu(panel: HTMLElement) {
  const triggers = within(panel).getAllByRole("button", { name: "Browser options" });
  await userEvent.click(triggers[0] as HTMLElement);
  const menu = await screen.findByRole("menu");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Engine" }));
}

async function pickEngine(name: "In-app browser" | "ace's Chrome") {
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

const urls = (browser: { view(id: string): { tabs?: { url: string }[] } | undefined }) =>
  browser.view(thread)?.tabs?.map((tab) => tab.url) ?? [];
const activeUrl = (browser: {
  view(id: string): { tabs?: { tabId: string; url: string }[]; activeTabId?: string } | undefined;
}) => {
  const view = browser.view(thread);
  return view?.tabs?.find((tab) => tab.tabId === view.activeTabId)?.url;
};

test("a tab's Engine menu moves the thread's browser to ace's Chrome and reloads its tabs there", async () => {
  const { panel, browser } = await openTwoTabs();
  const tabs = browser.tabsList(thread);
  const shown = tabs.find((tab) => tab.url === first);
  if (!shown) throw new Error("Missing the first tab");
  browser.setPrivate(thread, shown.tabId, true);

  await engineMenu(panel);
  await pickEngine("ace's Chrome");

  await waitFor(() => expect(browser.view(thread)?.backend).toBe("headless"));
  // Every tab loads its address again on the new engine, the shown one still shown, and a
  // tab agents were kept out of stays that way.
  expect(urls(browser)).toEqual([first, second]);
  expect(activeUrl(browser)).toBe(second);
  expect(browser.tabsList(thread).find((tab) => tab.url === first)?.private).toBe(true);
  // The panel shows the reloaded tab again, not the fallback the close left behind.
  await within(panel).findByRole("button", { name: "Browser options" });
});

test("switching back to the in-app browser restores the tabs there; picking the current engine keeps them", async () => {
  const { panel, browser } = await openTwoTabs();

  await engineMenu(panel);
  await pickEngine("ace's Chrome");
  await waitFor(() => expect(browser.view(thread)?.backend).toBe("headless"));
  await within(panel).findByRole("button", { name: "Browser options" });

  await engineMenu(panel);
  await pickEngine("In-app browser");
  await waitFor(() => expect(browser.view(thread)?.backend).toBe("embedded"));
  expect(urls(browser)).toEqual([first, second]);
  expect(activeUrl(browser)).toBe(second);
  await within(panel).findByRole("button", { name: "Browser options" });

  const ids = browser.tabsList(thread).map((tab) => tab.tabId);
  await engineMenu(panel);
  await pickEngine("In-app browser");
  await waitFor(() => expect(browser.view(thread)?.backend).toBe("embedded"));
  expect(browser.tabsList(thread).map((tab) => tab.tabId)).toEqual(ids);
});

test("a blank New tab switches engines without failing the move", async () => {
  desktopBridge();
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  const browser = app.daemon.browser;
  browser.drive(thread, { url: "about:blank", backend: "embedded" });
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("button", { name: "Browser options" });

  await engineMenu(panel);
  await pickEngine("ace's Chrome");

  await waitFor(() => expect(browser.view(thread)?.backend).toBe("headless"));
  expect(urls(browser)).toEqual(["about:blank"]);
});

test("a tab whose address can't reload skips that tab but still moves the rest", async () => {
  desktopBridge();
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  const browser = app.daemon.browser;
  browser.drive(thread, { url: "http://example.com:22/", backend: "embedded" });
  browser.personOpen(thread, second);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("button", { name: "Browser options" });

  await engineMenu(panel);
  await pickEngine("ace's Chrome");

  await waitFor(() => expect(browser.view(thread)?.backend).toBe("headless"));
  expect(urls(browser)).toContain(second);
  expect(activeUrl(browser)).toBe(second);
  const toast = await screen.findByRole("alertdialog", {
    name: "Couldn't switch the browser engine",
  });
  expect(toast.textContent).toContain("didn't reload");
});

test("outside the desktop app the tab menu offers no engine", async () => {
  const { panel } = await openTwoTabs({ desktop: false });
  const triggers = within(panel).getAllByRole("button", { name: "Browser options" });
  await userEvent.click(triggers[0] as HTMLElement);
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Engine" })).toBeNull();
});
