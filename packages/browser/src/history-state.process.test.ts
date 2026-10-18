import { expect, it } from "vitest";
import { setup, executablePath } from "./parity-test-support.ts";

/**
 * Back and Forward as clients read them: pushed with each tab's state through every
 * navigation, in ace's own Chrome. Nothing asks for them per address.
 */
const person = { kind: "human" as const, connectionId: "connection-1" };

async function page() {
  const f = await setup();
  const tab = () => {
    const state = f.service.state("thread");
    return state.tabs?.find((each) => each.tabId === state.activeTabId);
  };
  return { ...f, tab };
}

it.skipIf(!executablePath)(
  "a new tab's first page has nothing to go back to: the blank page it opened on doesn't count",
  async () => {
    const f = await page();
    await f.until(() => f.tab()?.canGoBack !== undefined);
    expect(f.tab()).toMatchObject({ canGoBack: false, canGoForward: false });
    expect(await f.execute({ action: "navigation_history" })).toMatchObject({ back: false });
    await f.service.execute("thread", { action: "history", direction: "back" }, person);
    expect(await f.evaluate("location.href")).toBe(f.url + "/");
  },
  60000,
);

it.skipIf(!executablePath)(
  "a single-page app's pushState turns Back on, and going back turns Forward on",
  async () => {
    const f = await page();
    await f.until(() => f.tab()?.canGoBack === false);
    await f.evaluate("history.pushState({}, '', '/watch?v=1')");
    await f.until(() => f.tab()?.canGoBack === true);
    expect(f.tab()?.canGoForward).toBe(false);
    await f.service.execute("thread", { action: "history", direction: "back" }, person);
    await f.until(() => f.tab()?.canGoForward === true);
    expect(f.tab()).toMatchObject({ url: f.url + "/", canGoBack: false });
  },
  60000,
);

it.skipIf(!executablePath)(
  "the person's Back leaves a page whose dialog is open, and the arrows stay current",
  async () => {
    const f = await page();
    await f.execute({ action: "navigate", url: f.url + "/other" });
    await f.until(() => f.tab()?.canGoBack === true);
    await f.evaluate("setTimeout(() => alert('Welcome!'), 0)");
    await f.until(() => f.service.state("thread").pending_dialog !== undefined);
    expect(f.tab()?.canGoBack).toBe(true);
    await f.service.execute("thread", { action: "history", direction: "back" }, person);
    await f.until(() => f.tab()?.url === f.url + "/" && f.tab()?.canGoForward === true);
  },
  60000,
);
