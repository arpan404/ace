import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import type { BrowserView } from "../sources.ts";
import { PageDialog } from "./page-dialog.tsx";

async function openBrowser(
  scenario = coldStartReplay(),
  path = "/t/thread-cold-start",
  through?: string,
) {
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
  return { app, panel, browser: app.daemon.browser, script };
}

const thread = "thread-cold-start";
/** The page the agent opened shows, as the screencast's live picture. */
const agentPage = (panel: HTMLElement) =>
  within(panel).findByRole("img", { name: "Live view of localhost:5173/settings/devices" });
/** The strip of the thread's browser tabs. */
const strip = (panel: HTMLElement) => within(panel).getByRole("tablist", { name: "Browser tabs" });
const shownTab = (panel: HTMLElement) => within(strip(panel)).getByRole("tab", { selected: true });

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

test("the browser shows the page an agent works in, marks its tab with the agent cursor, and follows its frames", async () => {
  const { panel, browser } = await openBrowser(coldStartReplay(), "/t/thread-cold-start", "turn-2");
  const frame = await agentPage(panel);
  expect(within(strip(panel)).getByRole("img", { name: /is using this tab$/ })).toBeTruthy();
  const first = frame.getAttribute("src");
  act(() => browser.type(thread, "iPhone 16 Pro Max"));
  await waitFor(() => expect(frame.getAttribute("src")).not.toBe(first));
  expect(decodeURIComponent(frame.getAttribute("src") ?? "")).toContain("iPhone 16 Pro Max");
  // At rest the address pill reads just the site; the field holds the whole address.
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:5173/settings/devices");
  // Nobody takes over or hands back: there is no such control.
  expect(within(panel).queryByRole("button", { name: /Take over|Hand back/ })).toBeNull();
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

test("typing an address in a new tab opens it in a new tab and shows it", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const agentTab = browser.view(thread)?.activeTabId;
  await userEvent.click(within(panel).getByRole("button", { name: "New browser tab" }));
  await waitFor(() => expect(shownTab(panel).textContent).toContain("New tab"));
  // The new tab's address takes the typing at once.
  expect(document.activeElement).toBe(address(panel));
  await userEvent.keyboard("arpan.sh{Enter}");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://arpan.sh/"));
  const tabs = browser.tabsList(thread);
  expect(tabs).toHaveLength(2);
  expect(browser.view(thread)?.activeTabId).not.toBe(agentTab);
  // The agent's page is untouched in its own tab.
  expect(tabs.find((tab) => tab.tabId === agentTab)?.url).toBe("localhost:5173/settings/devices");
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
  await waitFor(() => expect((address(panel) as HTMLInputElement).value).toBe("arpan.sh"));
});

test("closing the browser panel tab and opening a new one never resurrects the closed page", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await userEvent.click(within(panel).getByRole("button", { name: "New browser tab" }));
  await waitFor(() => expect(shownTab(panel).textContent).toContain("New tab"));
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://docs.example.com/guide"));
  // Closing the panel tab closes the person's tabs; the agent keeps its own.
  await userEvent.click(within(panel).getByRole("button", { name: "Close docs.example.com" }));
  await waitFor(() =>
    expect(browser.tabsList(thread).map((tab) => tab.url)).toEqual([
      "localhost:5173/settings/devices",
    ]),
  );
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  await userEvent.type(
    await within(panel).findByRole("combobox", { name: "Address" }),
    "example.org{Enter}",
  );
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://example.org/"));
  expect(browser.tabsList(thread).some((tab) => tab.url.includes("docs.example.com"))).toBe(false);
  expect(within(strip(panel)).queryByText(/docs\.example\.com/)).toBeNull();
});

test("an agent's new tab appears in the strip with the agent cursor and doesn't take the person's tab", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const mine = browser.view(thread)?.activeTabId ?? "";
  // The person picked the tab they view (on this device or another).
  act(() => browser.tabSelect(thread, mine));
  act(() => {
    browser.agentIdle(thread, mine);
    browser.tabOpen(thread, "https://shop.example/cart", { agentId: "worker", label: "checkout" });
  });
  await waitFor(() => expect(within(strip(panel)).getAllByRole("tab")).toHaveLength(2));
  const tabs = within(strip(panel)).getAllByRole("tab");
  expect(
    within(tabs[1] as HTMLElement).getByRole("img", { name: /is using this tab$/ }),
  ).toBeTruthy();
  expect(
    within(tabs[0] as HTMLElement).queryByRole("img", { name: /is using this tab$/ }),
  ).toBeNull();
  // The person's page stays shown.
  expect(browser.view(thread)?.activeTabId).toBe(mine);
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  // Picking the agent's tab shows it, on every device.
  await userEvent.click(tabs[1] as HTMLElement);
  await waitFor(() => expect(browser.view(thread)?.url).toBe("https://shop.example/cart"));
});

test("keeping agents out of a tab blocks agent commands there, and letting them back in allows them", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Keep agents out of this tab" }),
  );
  await waitFor(() => expect(browser.tab(thread)?.private).toBe(true));
  expect(await within(strip(panel)).findByRole("img", { name: "Agents kept out" })).toBeTruthy();
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
  await waitFor(() => expect(within(strip(panel)).getAllByRole("tab")).toHaveLength(3));
  const [, second, third] = browser.tabsList(thread);
  await userEvent.click(
    within(strip(panel)).getAllByRole("button", { name: /^Close / })[1] as HTMLElement,
  );
  await waitFor(() =>
    expect(browser.tabsList(thread).map((tab) => tab.tabId)).not.toContain(second?.tabId),
  );
  const last = within(strip(panel)).getAllByRole("tab")[1] as HTMLElement;
  fireEvent(last, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
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

test("while the window is hidden the browser stops pulling frames, and shows the latest once shown", async () => {
  const { panel, browser } = await openBrowser();
  await agentPage(panel);
  const page = () =>
    within(panel).getByRole("img", { name: "Live view of localhost:5173/settings/devices" });
  try {
    act(() => visibility("hidden"));
    act(() => browser.type(thread, "Pixel 9"));
    await waitFor(() =>
      expect(decodeURIComponent(page().getAttribute("src") ?? "")).toContain("Pixel 9"),
    );
    // That frame is not acknowledged while hidden, so the browser sends no more.
    act(() => browser.type(thread, "Galaxy S25"));
    await act(async () => {});
    expect(decodeURIComponent(page().getAttribute("src") ?? "")).not.toContain("Galaxy S25");
    act(() => visibility("visible"));
    await waitFor(() =>
      expect(decodeURIComponent(page().getAttribute("src") ?? "")).toContain("Galaxy S25"),
    );
  } finally {
    visibility("visible");
  }
});

test("screencast paste inserts clipboard text and pointer gestures retain their buttons and click counts", async () => {
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
    fireEvent.mouseDown(page, { clientX: 10, clientY: 20, button, detail });
    fireEvent.mouseUp(page, { clientX: 10, clientY: 20, button, detail });
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
