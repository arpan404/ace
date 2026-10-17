import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";

/** The cold-start thread with an agent driving its browser, the Browser tool open beside it. */
async function openBrowser() {
  const app = harness();
  app.play(coldStartReplay()).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole(
    "img",
    { name: "Live view of localhost:5173/settings/devices" },
    { timeout: 10000 },
  );
  return { app, panel, browser: app.daemon.browser };
}

test("an agent's new tab joins the strip and shows while the person hasn't picked a tab", async () => {
  const { panel, browser } = await openBrowser();
  const first = browser.view(threadId)?.activeTabId;
  act(() => browser.tabOpen(threadId, "https://status.example/", { agentId: "worker" }));
  const tabs = within(panel).getByRole("tablist", { name: "Browser tabs" });
  await waitFor(() => expect(within(tabs).getAllByRole("tab")).toHaveLength(2));
  expect(browser.tabsList(threadId)).toHaveLength(2);
  expect(browser.view(threadId)?.activeTabId).not.toBe(first);
  await waitFor(() =>
    expect(within(tabs).getByRole("tab", { selected: true }).textContent).toContain("Fixture page"),
  );
});

test("a page's question waits in the panel, and answering it clears it on the daemon", async () => {
  const { panel, browser } = await openBrowser();
  act(() => {
    browser.tabOpen(threadId, "https://shop.example/cart");
    const tabId = browser.view(threadId)?.activeTabId ?? "";
    browser.dialogOpen(threadId, {
      dialogId: "dialog-1",
      tabId,
      type: "confirm",
      message: "Remove 3 items from your cart?",
    });
  });

  const dialog = await within(panel).findByRole("alertdialog", { name: "shop.example asks" });
  expect(within(dialog).getByText("Remove 3 items from your cart?")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "OK" }));

  await waitFor(() => expect(browser.view(threadId)?.pending_dialog).toBeUndefined());
  await waitFor(() => expect(within(panel).queryByRole("alertdialog")).toBeNull());
});

test("downloads list what the page saved and flag executables; nothing offers to open them", async () => {
  const { panel, browser } = await openBrowser();
  act(() => {
    browser.tabOpen(threadId, "https://releases.example/");
    browser.downloadAdd(threadId, {
      downloadId: "download-1",
      tabId: browser.view(threadId)?.activeTabId ?? "",
      filename: "installer.pkg",
      bytes: 48_000_000,
      mimeType: "application/octet-stream",
      flags: ["executable"],
      state: "complete",
      path: "/Users/dev/.ace/artifacts/installer.pkg",
    });
  });

  await userEvent.click(await within(panel).findByRole("button", { name: "Downloads · 1" }));
  const list = await screen.findByRole("list", { name: "Downloads" });
  expect(within(list).getByText("installer.pkg")).toBeTruthy();
  expect(within(list).getByText(/Executable: check it before running/)).toBeTruthy();
  expect(within(list).queryByRole("button", { name: /^Open/ })).toBeNull();
  await userEvent.click(within(list).getByRole("button", { name: "More for installer.pkg" }));
  expect(await screen.findByRole("menuitem", { name: "Copy path" })).toBeTruthy();
});

test("a tab the person keeps agents out of is never recorded, and is marked in the strip", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Keep agents out of this tab" }),
  );
  await waitFor(() => expect(browser.tab(threadId)?.private).toBe(true));
  expect(await within(panel).findByRole("img", { name: "Agents kept out" })).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  const record = await screen.findByRole("menuitem", { name: /Record the page/ });
  expect(record.getAttribute("aria-disabled")).toBe("true");
  // Closing the panel leaves it private: agents stay out until the person lets them in.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
  expect(browser.tab(threadId)?.private).toBe(true);
});

test("picking a page size from the options closes the menu so the page can receive input again", async () => {
  const { panel } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Page size" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /iPhone 16 Pro/ }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(
    within(panel).getByRole("button", { name: "Browser options" }).getAttribute("aria-expanded"),
  ).toBe("false");
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Page size" }));
  const sizes = await screen.findAllByRole("menuitemradio");
  expect(
    sizes.filter((size) => size.getAttribute("aria-checked") === "true").map((s) => s.textContent),
  ).toEqual([expect.stringMatching(/iPhone 16 Pro/)]);
});

test("the browser options read like the app's other menus: shortcuts announced, no narration", async () => {
  const { panel } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  const menu = await screen.findByRole("menu");
  const find = within(menu).getByRole("menuitem", { name: "Find in page" });
  expect(find.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+F$/);
  expect(
    within(menu).getByRole("menuitem", { name: "Page size" }).getAttribute("aria-haspopup"),
  ).toBe("menu");
  // The page sizes live in their own submenu, not as a flat list in this one.
  expect(within(menu).queryByRole("menuitemradio")).toBeNull();
  expect(
    within(menu).getByRole("menuitemcheckbox", { name: "Keep agents out of this tab" }),
  ).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "Close tab" })).toBeTruthy();
  expect(within(menu).queryByText(/ace desktop app's browser|ace's own/)).toBeNull();
});

test("Find reads the page the agent works in, leaving the agent at work", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("combobox", { name: "Address" }));
  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await within(panel).findByRole("textbox", { name: "Find text" });
  await userEvent.type(find, "needle");
  await within(panel).findByText("1 of 1");
  expect(browser.tab(threadId)?.inUse).toMatchObject({ kind: "agent" });
});

test("a page's unanswered question stays visible when its panel is closed", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
  act(() =>
    browser.dialogOpen(threadId, {
      dialogId: "hidden-question",
      tabId: browser.view(threadId)?.activeTabId ?? "",
      type: "confirm",
      message: "Continue the form?",
    }),
  );
  const question = await screen.findByRole("alertdialog");
  expect(within(question).getByText("Continue the form?")).toBeTruthy();
  await userEvent.click(within(question).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(browser.view(threadId)?.pending_dialog).toBeUndefined());
});

test("a disconnected page offers Reopen and resumes at its last address", async () => {
  const { panel, browser } = await openBrowser();
  const before = browser.view(threadId)?.url;
  act(() => browser.lose(threadId));
  await userEvent.click(await within(panel).findByRole("button", { name: "Reopen" }));
  await waitFor(() =>
    expect(browser.view(threadId)).toMatchObject({ status: "ready", url: before }),
  );
  await waitFor(() => expect(within(panel).queryByRole("button", { name: "Reopen" })).toBeNull());
});
