import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";
import type { BrowserView } from "../sources.ts";
import { PageDialog } from "./page-dialog.tsx";

async function openBrowser(
  scenario = coldStartReplay(),
  path = "/t/thread-cold-start",
  through?: string,
) {
  const video = browserVideo();
  const app = harness();
  const script = app.play(scenario);
  if (through) script.runThrough(through);
  else script.step();
  seedPanels(app.daemon);
  await app.open(path);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  // ⌃⇧B opens the Browser in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  return { app, panel, browser: app.daemon.browser, script, video };
}

const thread = "thread-cold-start";
/** The page the agent opened shows, as its live video picture. */
const agentPage = (panel: HTMLElement) =>
  within(panel).findByRole("img", { name: "Live view of localhost:5173/settings/devices" });
/** The panel's own tab strip: each of the thread's browser tabs is one of its tabs. */
const strip = (panel: HTMLElement) =>
  within(panel).getByRole("tablist", { name: "Thread panel tabs" });
const shownTab = (panel: HTMLElement) => within(strip(panel)).getByRole("tab", { selected: true });
const tools = new Set(["Summary", "Changes", "Files"]);
/** The panel tabs that are browser tabs, in strip order. */
const pageTabs = (panel: HTMLElement) =>
  within(strip(panel))
    .getAllByRole("tab")
    .filter((tab) => !tools.has(tab.textContent?.trim() ?? ""));

const address = (panel: HTMLElement) => within(panel).getByRole("combobox", { name: "Address" });

const promptView = (dialogId: string): BrowserView => ({
  threadId: "dialog-thread",
  url: "http://localhost:5173/",
  closed: false,
  pendingDialog: {
    tabId: "page-tab",
    dialogId,
    type: "prompt",
    message: "Fixture prompt",
    defaultPrompt: "seed",
  },
});

test("an answered prompt stays locked until the daemon replaces it, and the next prompt gets its own answer", async () => {
  const first = Promise.withResolvers<{ ok: true } | undefined>();
  let pageResult: string | null | undefined;
  const browser = {
    answerDialog: (_tabId: string, dialogId: string, accept: boolean, text?: string) => {
      if (dialogId === "main") return first.promise;
      pageResult = accept ? text : null;
      return Promise.resolve({ ok: true } as const);
    },
  };
  const ui = render(<PageDialog view={promptView("main")} browser={browser} />);
  await userEvent.clear(screen.getByRole("textbox", { name: "Answer" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Answer" }), "answered");
  await userEvent.click(screen.getByRole("button", { name: /^OK$/ }));
  expect(screen.getByRole("textbox", { name: "Answer" }).hasAttribute("disabled")).toBe(true);
  await act(async () => first.resolve({ ok: true }));
  // The command's reply can arrive before the browser-state update.
  expect(screen.getByRole("textbox", { name: "Answer" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: /^OK$/ }).hasAttribute("disabled")).toBe(true);

  ui.rerender(<PageDialog view={promptView("iframe")} browser={browser} />);
  const next = screen.getByRole("textbox", { name: "Answer" });
  expect(next.hasAttribute("disabled")).toBe(false);
  expect(next.getAttribute("value")).toBe("seed");
  await userEvent.clear(next);
  await userEvent.type(next, "iframe answer{Enter}");
  expect(pageResult).toBe("iframe answer");
});

test("a late refusal for an older dialog cannot unlock a newer submission, and a refused answer can retry", async () => {
  const first = Promise.withResolvers<{ ok: true } | undefined>();
  const next = Promise.withResolvers<{ ok: true } | undefined>();
  const browser = {
    answerDialog: (_tabId: string, dialogId: string) =>
      dialogId === "main" ? first.promise : next.promise,
  };
  const ui = render(<PageDialog view={promptView("main")} browser={browser} />);
  await userEvent.click(screen.getByRole("button", { name: /^OK$/ }));
  ui.rerender(<PageDialog view={promptView("iframe")} browser={browser} />);
  const field = screen.getByRole("textbox", { name: "Answer" });
  await userEvent.clear(field);
  await userEvent.type(field, "iframe answer");
  await userEvent.click(screen.getByRole("button", { name: /^OK$/ }));
  await act(async () => first.resolve(undefined));
  expect(field.hasAttribute("disabled")).toBe(true);
  await act(async () => next.resolve(undefined));
  expect(field.hasAttribute("disabled")).toBe(false);
  expect(field.getAttribute("value")).toBe("iframe answer");
  expect(screen.getByRole("button", { name: /^OK$/ }).hasAttribute("disabled")).toBe(false);
});

async function goTo(panel: HTMLElement, text: string) {
  const field = await within(panel).findByRole("combobox", { name: "Address" });
  await userEvent.clear(field);
  await userEvent.type(field, `${text}{Enter}`);
}

test("the browser shows the page an agent works in, marks its tab with the agent cursor, and follows its pictures", async () => {
  const { panel, browser, video } = await openBrowser(
    coldStartReplay(),
    "/t/thread-cold-start",
    "turn-2",
  );
  const picture = await agentPage(panel);
  expect(within(strip(panel)).getByRole("img", { name: /is using this tab$/ })).toBeTruthy();
  act(() => browser.type(thread, "iPhone 16 Pro Max"));
  const typed = browser.frame(thread)?.sequence;
  await waitFor(() => expect(video.shown(picture)).toBe(typed));
  // At rest the address pill reads just the site; the field holds the whole address.
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:5173/settings/devices");
  // Nobody takes over or hands back: there is no such control.
  expect(within(panel).queryByRole("button", { name: /Take over|Hand back/ })).toBeNull();
});

test("a browser that can't decode video says so in place of the page, and the rest still works", async () => {
  // jsdom has no WebCodecs, as an older browser hasn't.
  const scenario = coldStartReplay();
  const app = harness();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    await within(panel).findByRole("heading", { name: "This browser can't decode video" }),
  ).toBeTruthy();
  expect(within(panel).queryByRole("img", { name: /^Live view of/ })).toBeNull();
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:5173/settings/devices");
});

test("the person can use a tab an agent is working in, with no control to take", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  act(() => browser.agentWorks(thread, { agentId: "worker", pointer: { x: 40, y: 60 } }));
  const page = within(panel).getByRole("application", {
    name: "Control localhost:5173/settings/devices",
  });
  // jsdom lays every element out 800px wide; the page starts at 760 and follows the panel.
  await waitFor(() => expect(browser.frame(thread)?.width).toBe(800));
  fireEvent.mouseDown(page, { clientX: 10, clientY: 20 });
  fireEvent.mouseUp(page, { clientX: 10, clientY: 20 });
  fireEvent.wheel(page, { clientX: 10, clientY: 20, deltaY: 120 });
  page.focus();
  await userEvent.keyboard("a");
  const tabId = browser.view(thread)?.activeTabId;
  await waitFor(() =>
    expect(
      browser.wireInputs.map(({ input }) => `${input.kind}:${"event" in input ? input.event : ""}`),
    ).toEqual(["mouse:mousePressed", "mouse:mouseReleased", "scroll:", "key:keyDown", "key:keyUp"]),
  );
  // Every input names the tab it was typed into.
  expect(new Set(browser.wireInputs.map((entry) => entry.tabId))).toEqual(new Set([tabId]));
  expect(
    browser.wireInputs.filter(({ input }) => input.kind === "key").map(({ input }) => input),
  ).toEqual([
    { kind: "key", event: "keyDown", key: "a", code: "KeyA", modifiers: 0, text: "a" },
    { kind: "key", event: "keyUp", key: "a", code: "KeyA", modifiers: 0 },
  ]);
  // The agent keeps working there too, its cursor over the page where it pointed.
  expect(within(panel).getByRole("img", { name: /is pointing here$/ })).toBeTruthy();
  expect(browser.tab(thread)?.inUse).toMatchObject({ kind: "agent", agentId: "worker" });
});

test("a wheel over the page scrolls whatever is under the pointer in Chrome, never ace or the picture", async () => {
  const { panel, browser } = await openBrowser();
  const picture = await agentPage(panel);
  const page = within(panel).getByRole("application", {
    name: "Control localhost:5173/settings/devices",
  });
  await waitFor(() => expect(browser.frame(thread)?.width).toBe(800));
  // A trackpad's fractional step: ace keeps it to itself (no panel scroll, zoom or swipe back).
  expect(fireEvent.wheel(page, { clientX: 30, clientY: 40, deltaX: 0.5, deltaY: 12.25 })).toBe(
    false,
  );
  await waitFor(() =>
    expect(browser.wireInputs.map(({ input }) => input)).toContainEqual({
      kind: "scroll",
      x: 30,
      y: 40,
      deltaX: 0.5,
      deltaY: 12.25,
      modifiers: 0,
    }),
  );
  // The picture stays where it is until Chrome's next frame shows what scrolled.
  expect(picture.style.transform).toBe("");
});

test("a new browser tab's address opens a daemon tab, which becomes that panel tab", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const agentTab = browser.view(thread)?.activeTabId;
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await userEvent.click(await within(panel).findByRole("button", { name: /^Browser/ }));
  await waitFor(() => expect(shownTab(panel).textContent).toContain("New tab"));
  // The new tab's address takes the typing at once.
  await waitFor(() => expect(document.activeElement).toBe(address(panel)));
  await userEvent.keyboard("arpan.sh{Enter}");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://arpan.sh/"));
  const tabs = browser.tabsList(thread);
  expect(tabs).toHaveLength(2);
  expect(browser.view(thread)?.activeTabId).not.toBe(agentTab);
  // The agent's page is untouched in its own tab, and the strip holds one tab per daemon tab.
  expect(tabs.find((tab) => tab.tabId === agentTab)?.url).toBe("localhost:5173/settings/devices");
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
  expect(shownTab(panel).textContent).toContain("Fixture page");
  await waitFor(() => expect((address(panel) as HTMLInputElement).value).toBe("arpan.sh"));
});

test("an address from the new-tab launcher opens in a new browser tab, never over the shown page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const agentTab = browser.view(thread)?.activeTabId;
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const field = await within(panel).findByRole("combobox", { name: "Address" });
  await userEvent.type(field, "arpan.sh{Enter}");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://arpan.sh/"));
  expect(browser.tabsList(thread)).toHaveLength(2);
  expect(browser.view(thread)?.activeTabId).not.toBe(agentTab);
  await waitFor(() => expect(shownTab(panel).textContent).toContain("Fixture page"));
  expect(pageTabs(panel)).toHaveLength(2);
  await waitFor(() => expect((address(panel) as HTMLInputElement).value).toBe("arpan.sh"));
});

test("closing a top tab closes its browser tab, and a new one never resurrects the closed page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await userEvent.type(
    await within(panel).findByRole("combobox", { name: "Address" }),
    "docs.example.com/guide{Enter}",
  );
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
  act(() => browser.pageIdentity(thread, { title: "Guide" }));
  await userEvent.click(await within(panel).findByRole("button", { name: "Close Guide" }));
  // Only that daemon tab closes; the agent's stays, and so does its panel tab.
  await waitFor(() =>
    expect(browser.tabsList(thread).map((tab) => tab.url)).toEqual([
      "localhost:5173/settings/devices",
    ]),
  );
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(1));
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await userEvent.type(
    await within(panel).findByRole("combobox", { name: "Address" }),
    "example.org{Enter}",
  );
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://example.org/"));
  expect(browser.tabsList(thread).some((tab) => tab.url.includes("docs.example.com"))).toBe(false);
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
});

test("an agent tab appears as a top tab with the agent cursor and doesn't steal focus", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const mine = browser.view(thread)?.activeTabId ?? "";
  // The person picked the tab they view (on this device or another).
  act(() => browser.tabSelect(thread, mine));
  act(() => {
    browser.agentIdle(thread, mine);
    browser.tabOpen(thread, "https://shop.example/cart", { agentId: "worker", label: "checkout" });
  });
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
  const [first, second] = pageTabs(panel);
  expect(
    within(second as HTMLElement).getByRole("img", { name: /is using this tab$/ }),
  ).toBeTruthy();
  expect(
    within(first as HTMLElement).queryByRole("img", { name: /is using this tab$/ }),
  ).toBeNull();
  // The person's page stays shown, here and on the daemon.
  expect(browser.view(thread)?.activeTabId).toBe(mine);
  expect(first?.getAttribute("aria-selected")).toBe("true");
  // Picking the agent's tab shows it, on every device.
  await userEvent.click(second as HTMLElement);
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://shop.example/cart"));
});

test("each daemon tab is one top-level panel tab, beside the panel's tools", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  act(() => {
    browser.tabOpen(thread, "https://one.example/", { agentId: "a" });
    browser.tabOpen(thread, "https://two.example/", { agentId: "b" });
  });
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(3));
  // No second strip of tabs inside the page.
  expect(within(panel).getAllByRole("tablist")).toHaveLength(1);
  // A tab the daemon shows elsewhere (an agent's, while the person looked away) is shown here.
  const two = browser.tabsList(thread)[2]?.tabId ?? "";
  act(() => browser.tabSelect(thread, two));
  await waitFor(() => expect(shownTab(panel)).toBe(pageTabs(panel)[2]));
  // A daemon tab that closes leaves the strip.
  act(() => void browser.tabClose(thread, browser.tabsList(thread)[1]?.tabId ?? ""));
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
});

test("the tab title and favicon follow the page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  act(() => browser.agentIdle(thread));
  const favicon = "data:image/png;base64,iVBORw0KGgo=";
  act(() => browser.pageIdentity(thread, { title: "Inbox (3)", favicon }));
  await waitFor(() => expect(shownTab(panel).textContent).toContain("Inbox (3)"));
  expect(shownTab(panel).querySelector("img[data-favicon]")?.getAttribute("src")).toBe(favicon);
  act(() => browser.pageIdentity(thread, { title: "Inbox (4)", favicon }));
  await waitFor(() => expect(shownTab(panel).textContent).toContain("Inbox (4)"));
  // A page with no icon shows the globe, never the last page's icon.
  await goTo(panel, "docs.example.com");
  await waitFor(() => expect(shownTab(panel).textContent).toContain("Fixture page"));
  expect(shownTab(panel).querySelector("img[data-favicon]")).toBeNull();
});

test("keeping agents out of a tab blocks agent commands there, and letting them back in allows them", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Keep agents out of this tab" }),
  );
  await waitFor(() => expect(browser.tab(thread)?.private).toBe(true));
  expect(await within(shownTab(panel)).findByRole("img", { name: "Agents kept out" })).toBeTruthy();
  await expect(browser.navigateAgent(thread, "https://elsewhere.example/")).rejects.toThrow(
    "human_private",
  );
  // The person still uses the tab as before.
  await goTo(panel, "docs.example.com");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/"));
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Keep agents out of this tab" }),
  );
  await waitFor(() => expect(browser.tab(thread)?.private).toBeUndefined());
  await browser.navigateAgent(thread, "https://elsewhere.example/");
  expect(browser.view(thread)?.url).toBe("https://elsewhere.example/");
});

test("closing a tab from the strip closes it on the daemon, and middle-click closes too", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  act(() => {
    browser.tabOpen(thread, "https://one.example/", { agentId: "a" });
    browser.tabOpen(thread, "https://two.example/", { agentId: "b" });
  });
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(3));
  const [, second, third] = browser.tabsList(thread);
  act(() => {
    browser.agentIdle(thread, second?.tabId);
    browser.agentIdle(thread, third?.tabId);
  });
  fireEvent(
    pageTabs(panel)[1] as HTMLElement,
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  await waitFor(() =>
    expect(browser.tabsList(thread).map((tab) => tab.tabId)).not.toContain(second?.tabId),
  );
  await waitFor(() => expect(pageTabs(panel)).toHaveLength(2));
  fireEvent(
    pageTabs(panel)[1] as HTMLElement,
    new MouseEvent("auxclick", { bubbles: true, button: 1 }),
  );
  await waitFor(() =>
    expect(browser.tabsList(thread).map((tab) => tab.tabId)).not.toContain(third?.tabId),
  );
});

test("an address opens; Back returns; a dead port says why", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));

  const retainedFrame = browser.frame(thread)?.sequence;
  await goTo(panel, "localhost:4321");
  const failure = await within(panel).findByRole("alert");
  expect(within(failure).getByText("This site can't be reached")).toBeTruthy();
  expect(failure.textContent).not.toContain("ERR_CONNECTION_REFUSED");
  expect(failure.textContent).toContain("refused to connect. Is its server running?");
  // The failed address stays in the bar, with Reload beside the explanation.
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:4321");
  expect(within(failure).getByRole("button", { name: "Reload" })).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect((address(panel) as HTMLInputElement).value).toBe("docs.example.com/guide"),
  );
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide");
  expect(browser.frame(thread)?.sequence).toBe(retainedFrame);
});

test("document Back and Forward follow successful navigation and Reload refreshes the current page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));
  await goTo(panel, "example.org/next");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://example.org/next"));
  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));
  await waitFor(() => expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide"));
  const forward = within(panel).getByRole("button", { name: "Forward" });
  await waitFor(() => expect(forward.getAttribute("aria-disabled")).not.toBe("true"));
  await userEvent.click(forward);
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://example.org/next"));
  const sequence = browser.frame(thread)?.sequence ?? 0;
  await userEvent.click(within(panel).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(browser.frame(thread)?.sequence).toBeGreaterThan(sequence));
  expect(browser.view(thread)?.url).toBe("https://example.org/next");
});

test("Back traverses a failed navigation that replaced the document and clears the error", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() => expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide"));
  // Chromium can commit an error document before returning a navigation failure.
  const navigate = browser.navigate.bind(browser);
  vi.spyOn(browser, "navigate").mockImplementationOnce((...args) => {
    navigate(...args);
    throw new Error("net::ERR_CONNECTION_TIMED_OUT");
  });
  await goTo(panel, "example.org/timeout");
  await within(panel).findByRole("alert");
  expect(browser.view(thread)?.url).toBe("https://example.org/timeout");
  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));
  await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
  expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide");
});

test("a failure reported after the page committed doesn't hide the page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() => expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide"));
  // The page committed the address, but the daemon's wait for it ran out.
  const navigate = browser.navigate.bind(browser);
  vi.spyOn(browser, "navigate").mockImplementationOnce((...args) => {
    navigate(...args);
    throw new Error("Tool operation timed out");
  });
  await goTo(panel, "example.org/slow");
  await waitFor(() => expect(within(panel).queryByRole("button", { name: "Stop" })).toBeNull());
  expect(
    await within(panel).findByRole("img", { name: "Live view of https://example.org/slow" }),
  ).toBeTruthy();
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(address(panel).getAttribute("value")).toBe("example.org/slow");
});

test("text that isn't an address is refused instead of searched", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await goTo(panel, "how to center a div");
  expect(await within(panel).findByText(/That isn't an address/)).toBeTruthy();
  expect(browser.view(thread)?.url).toBe("localhost:5173/settings/devices");
});

test("a thread's first page downloads the browser with progress, then opens the address", async () => {
  const { panel, browser } = await openBrowser(failingSubagent(), "/t/thread-settings");
  expect(await within(panel).findByRole("combobox", { name: "Address" })).toBeTruthy();
  expect(within(panel).queryByRole("heading", { name: "Open a page" })).toBeNull();
  browser.requireDownload(150_000_000);
  await goTo(panel, "localhost:5173");

  expect(
    await within(panel).findByRole("heading", { name: "Getting the browser ready" }),
  ).toBeTruthy();
  const bar = within(panel).getByRole("progressbar", { name: "Downloading the browser" });
  expect(bar.getAttribute("aria-valuetext")).toBe("Downloading the browser · 40%");
  act(() => browser.finishDownload());
  // Nothing listens on 5173 for this thread, so Chromium says so.
  expect(await within(panel).findByText("This site can't be reached")).toBeTruthy();
  expect(browser.view("thread-settings")?.closed).toBe(false);
  // The address went into the new browser's own first tab, not a second one beside it.
  expect(browser.tabsList("thread-settings")).toHaveLength(1);
});

test("opening the Browser on a fresh thread shows a focused address field", async () => {
  const { panel, browser } = await openBrowser(failingSubagent(), "/t/thread-settings");
  expect(browser.view("thread-settings")).toBeUndefined();
  // A usable new tab at once: its address takes the typing without a click.
  const field = await within(panel).findByRole("combobox", { name: "Address" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(shownTab(panel).textContent).toContain("New tab");
  await userEvent.keyboard("example.org{Enter}");
  // Enter opens a daemon tab, which becomes the shown top tab.
  await waitFor(() => expect(browser.tabsList("thread-settings")).toHaveLength(1));
  await waitFor(() => expect(shownTab(panel).textContent).not.toContain("New tab"));
  expect(pageTabs(panel)).toHaveLength(1);
  await waitFor(() => expect(browser.view("thread-settings")?.url).toBe("https://example.org/"));
});

test("when the window loses focus to the page, the chrome lets go of its focused button but keeps an address being typed", async () => {
  const { panel } = await openBrowser();
  await agentPage(panel);
  const options = within(panel).getByRole("button", { name: "Browser options" });
  options.focus();
  expect(document.activeElement).toBe(options);
  // The desktop's native page taking focus blurs the app's window.
  act(() => window.dispatchEvent(new FocusEvent("blur")));
  expect(document.activeElement).not.toBe(options);

  const field = address(panel) as HTMLInputElement;
  await userEvent.click(field);
  await userEvent.keyboard("docs.exa");
  act(() => window.dispatchEvent(new FocusEvent("blur")));
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("docs.exa");
});

/** Hide or show the page, as switching tabs or minimising the window does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("while the window is hidden the browser stops pulling pictures, and shows the latest once shown", async () => {
  const { panel, browser, video } = await openBrowser();
  const picture = await agentPage(panel);
  try {
    act(() => visibility("hidden"));
    act(() => browser.type(thread, "Pixel 9"));
    const pixel = browser.frame(thread)?.sequence;
    await waitFor(() => expect(video.frames.at(-1)?.timestamp).toBe(pixel));
    // That picture's ack is owed while hidden, so the browser sends no more.
    act(() => browser.type(thread, "Galaxy S25"));
    await act(async () => {});
    expect(video.frames.at(-1)?.timestamp).toBe(pixel);
    act(() => visibility("visible"));
    const galaxy = browser.frame(thread)?.sequence;
    await waitFor(() => expect(video.shown(picture)).toBe(galaxy));
  } finally {
    visibility("visible");
  }
});

test("screencast paste inserts clipboard text and pointer gestures retain their buttons and click counts (⇧ right click goes to the page)", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const page = await within(panel).findByRole("application");
  page.focus();
  expect(fireEvent.keyDown(page, { key: "v", code: "KeyV", ctrlKey: true })).toBe(true);
  fireEvent.paste(page, { clipboardData: { files: [], getData: () => "Pasted fixture" } });
  for (const [button, detail] of [
    [0, 2],
    [1, 1],
    [2, 1],
  ]) {
    // A plain right click opens ace's page menu; with ⇧ it is the page's own.
    const shiftKey = button === 2;
    fireEvent.mouseDown(page, { clientX: 10, clientY: 20, button, detail, shiftKey });
    fireEvent.mouseUp(page, { clientX: 10, clientY: 20, button, detail, shiftKey });
  }
  await waitFor(() =>
    expect(browser.wireInputs.filter(({ input }) => input.kind === "mouse")).toHaveLength(6),
  );
  expect(browser.wireInputs.map(({ input }) => input)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "key", event: "char", text: "Pasted fixture" }),
      expect.objectContaining({ kind: "mouse", button: "left", clickCount: 2 }),
      expect.objectContaining({ kind: "mouse", button: "middle", clickCount: 1 }),
      expect.objectContaining({ kind: "mouse", button: "right", clickCount: 1 }),
    ]),
  );
});

test("Cut with a collapsed caret preserves clipboard text and page contents", async () => {
  // Installs a clipboard for the page to read and write.
  userEvent.setup();
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const page = await within(panel).findByRole("application");
  await navigator.clipboard.writeText("Keep the clipboard");
  await act(async () => {
    fireEvent.keyDown(page, { key: "x", code: "KeyX", ctrlKey: true });
    fireEvent.keyUp(page, { key: "x", code: "KeyX", ctrlKey: true });
  });
  expect(await navigator.clipboard.readText()).toBe("Keep the clipboard");
  expect(
    browser.wireInputs.some(({ input }) => input.kind === "key" && input.key === "Backspace"),
  ).toBe(false);
});
