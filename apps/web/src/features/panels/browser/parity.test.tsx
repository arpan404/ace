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
  await within(panel).findByText("is browsing", { exact: false }, { timeout: 10000 });
  return { app, panel, browser: app.daemon.browser };
}

test("agent navigation reuses the single panel tab", async () => {
  const { panel, browser } = await openBrowser();
  const first = browser.view(threadId)?.activeTabId;
  act(() => browser.tabOpen(threadId, "https://status.example/"));
  expect(
    await within(panel).findByRole("tab", { name: /^status\.example/, selected: true }),
  ).toBeTruthy();
  expect(browser.tabsList(threadId)).toHaveLength(1);
  expect(browser.view(threadId)?.activeTabId).toBe(first);
  expect(within(panel).queryByRole("tab", { name: /^localhost:5173/ })).toBeNull();
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
      path: "/Users/dev/.ace-next/artifacts/installer.pkg",
    });
  });

  await userEvent.click(await within(panel).findByRole("button", { name: "Downloads · 1" }));
  const list = await screen.findByRole("list", { name: "Downloads" });
  expect(within(list).getByText("installer.pkg")).toBeTruthy();
  expect(within(list).getByText("Executable: check it before running")).toBeTruthy();
  expect(within(list).queryByRole("button", { name: /^Open/ })).toBeNull();
  expect(within(list).getByRole("button", { name: "Copy path" })).toBeTruthy();
});

test("a private takeover hides the page from agents, refuses recording, and hands back to the agent", async () => {
  const { panel, browser } = await openBrowser();

  await userEvent.click(within(panel).getByRole("button", { name: "Make private" }));

  await waitFor(() => expect(browser.view(threadId)?.takeoverMode).toBe("private"));
  expect(
    await within(panel).findByText("agents can't see, read or record", { exact: false }),
  ).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  const record = await screen.findByRole("menuitem", { name: /Record the page/ });
  expect(record.getAttribute("aria-disabled")).toBe("true");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(within(panel).getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
  expect(browser.view(threadId)?.takeoverMode).not.toBe("private");
});

test("making a page you hold private keeps your control, and Hand back ends private mode", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take over" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("human"));
  await within(panel).findByText("You're browsing", { exact: false });

  await userEvent.click(within(panel).getByRole("button", { name: "Make private" }));
  await waitFor(() => expect(browser.view(threadId)?.takeoverMode).toBe("private"));
  expect(browser.view(threadId)?.controller).toBe("human");
  // Private already: the toggle shows it, and Hand back is what ends it.
  await waitFor(() =>
    expect(
      within(panel).getByRole("button", { name: "Make private" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
  expect(browser.view(threadId)?.takeoverMode).toBe("shared");
  expect(await within(panel).findByRole("button", { name: "Take over" })).toBeTruthy();
});

test("a private page whose holder dropped stays paused for agents until it is taken back privately", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Make private" }));
  await waitFor(() => expect(browser.view(threadId)?.takeoverMode).toBe("private"));
  const owner = browser.view(threadId)?.owner ?? "";
  act(() => browser.disconnect(owner));

  expect(await within(panel).findByText("Private and paused", { exact: false })).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Take over" })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Take back privately" }));
  await waitFor(() =>
    expect(browser.view(threadId)).toMatchObject({ controller: "human", takeoverMode: "private" }),
  );
  await userEvent.click(await within(panel).findByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
});

test("revoking a site's read-only scripts removes the daemon's grant", async () => {
  const { panel, browser } = await openBrowser();
  act(() =>
    browser.evaluateGrant(threadId, {
      origin: "https://shop.example",
      mode: "read-only",
      grantedAt: 1,
    }),
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Site access" }));
  const scripts = await screen.findByRole("region", { name: "Read-only scripts" });
  await userEvent.click(
    await within(scripts).findByRole("button", { name: "Revoke scripts on shop.example" }),
  );

  await waitFor(() => expect(browser.evaluateGrantsList(threadId)).toEqual([]));
  await waitFor(() => expect(within(scripts).queryByText("shop.example")).toBeNull());
});

test("closing the browser tab keeps a private page private: agents stay locked out until Hand back", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Make private" }));
  await waitFor(() => expect(browser.view(threadId)?.takeoverMode).toBe("private"));
  const before = browser.frame(threadId)?.src;

  // Leave the page: the browser's workspace tab closes and its view unmounts.
  await userEvent.click(within(panel).getByRole("button", { name: /^Close localhost/ }));
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: "Make private" })).toBeNull(),
  );

  expect(browser.view(threadId)?.controller).toBe("human");
  expect(browser.view(threadId)?.takeoverMode).toBe("private");
  // An agent acting on the page changes nothing while it is held privately.
  act(() => browser.type(threadId, "agent typing"));
  expect(browser.frame(threadId)?.src).toBe(before);
});

test("the browser has no new-tab shortcut or menu item", async () => {
  const { panel, browser } = await openBrowser();
  const first = browser.view(threadId)?.activeTabId;
  await userEvent.click(within(panel).getByRole("combobox", { name: "Address" }));
  await userEvent.keyboard("{Meta>}t{/Meta}");
  expect(within(panel).queryByRole("tab", { name: "New page" })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "New browser tab" })).toBeNull();
  expect(browser.view(threadId)?.activeTabId).toBe(first);
  expect(browser.tabsList(threadId)).toHaveLength(1);
});

test("picking a page size from the options closes the menu so the page can receive input again", async () => {
  const { panel } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /iPhone 16 Pro/ }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(
    within(panel).getByRole("button", { name: "Browser options" }).getAttribute("aria-expanded"),
  ).toBe("false");
});

test("Find reads the page without taking the agent's control", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("combobox", { name: "Address" }));
  await userEvent.keyboard("{Meta>}f{/Meta}");
  const find = await within(panel).findByRole("textbox", { name: "Find text" });
  expect(browser.view(threadId)?.controller).toBe("agent");
  await userEvent.type(find, "needle");
  await within(panel).findByText("1 of 1");
  expect(browser.view(threadId)?.controller).toBe("agent");
});

test("switching tools keeps a shared hold; closing the panel hands it back", async () => {
  const { panel, browser } = await openBrowser();
  await userEvent.click(within(panel).getByRole("button", { name: "Take over" }));
  await within(panel).findByText("You're browsing", { exact: false });
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  expect(browser.view(threadId)?.controller).toBe("human");
  await userEvent.click(within(panel).getByRole("button", { name: "Right panel" }));
  await waitFor(() => expect(browser.view(threadId)?.controller).toBe("agent"));
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
    expect(browser.view(threadId)).toMatchObject({
      status: "ready",
      url: before,
      controller: "agent",
    }),
  );
  await waitFor(() => expect(within(panel).queryByRole("button", { name: "Reopen" })).toBeNull());
  expect(within(panel).getByRole("button", { name: "Take over" })).toBeTruthy();
});
