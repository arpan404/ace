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

test("a page an agent opens gets a browser tab of its own, named by its site, and the panel follows it", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByRole("tab", { name: /^localhost:5173/, selected: true });
  act(() => browser.tabOpen(threadId, "https://status.example/"));
  // The person was watching the live page, so the panel shows the agent's new page.
  expect(
    await within(panel).findByRole("tab", { name: /^status\.example/, selected: true }),
  ).toBeTruthy();
  expect(
    within(panel)
      .getAllByRole("tab")
      .filter((tab) => /^(localhost|status)/.test(tab.textContent ?? "")),
  ).toHaveLength(browser.tabsList(threadId).length);
  // No strip of pages inside the browser: one page per tab.
  expect(within(panel).queryByRole("tablist", { name: "Agent tabs" })).toBeNull();
});

test("when an agent closes a page it opened, that page's tab goes with it", async () => {
  const { panel, browser } = await openBrowser();
  act(() => browser.tabOpen(threadId, "https://status.example/"));
  await within(panel).findByRole("tab", { name: /^status\.example/ });
  const opened = browser.tabsList(threadId).find((tab) => tab.url === "https://status.example/");
  act(() => browser.tabClose(threadId, opened?.tabId ?? ""));
  await waitFor(() =>
    expect(within(panel).queryByRole("tab", { name: /^status\.example/ })).toBeNull(),
  );
  // The page that stays keeps its tab, live again.
  expect(
    await within(panel).findByRole("tab", { name: /^localhost:5173/, selected: true }),
  ).toBeTruthy();
});

test("showing another page's tab switches the page, and closing a page's tab closes that page", async () => {
  const { panel, browser } = await openBrowser();
  const [first] = browser.tabsList(threadId);
  act(() => browser.tabOpen(threadId, "https://status.example/"));
  await within(panel).findByRole("tab", { name: /^status\.example/, selected: true });

  // The agent drives the other page, so this one waits until the person asks to see it.
  await userEvent.click(within(panel).getByRole("tab", { name: /^localhost:5173/ }));
  await userEvent.click(await within(panel).findByRole("button", { name: "Show this page" }));
  await waitFor(() => expect(browser.view(threadId)?.activeTabId).toBe(first?.tabId));
  // Switching pages needs the person's lease, so it took control first.
  expect(browser.view(threadId)?.controller).toBe("human");

  // Holding the page, showing a tab switches to its page straight away.
  await userEvent.click(within(panel).getByRole("tab", { name: /^status\.example/ }));
  await waitFor(() => expect(browser.view(threadId)?.url).toBe("https://status.example/"));

  const status = browser.tabsList(threadId).find((tab) => tab.url === "https://status.example/");
  await userEvent.click(within(panel).getByRole("button", { name: /^Close status\.example/ }));
  await waitFor(() =>
    expect(browser.tabsList(threadId).map((tab) => tab.tabId)).not.toContain(status?.tabId),
  );
  expect(browser.tabsList(threadId).map((tab) => tab.tabId)).toEqual([first?.tabId]);
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
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(browser.view(threadId)?.controller).toBe("human");
  expect(browser.view(threadId)?.takeoverMode).toBe("private");
  // An agent acting on the page changes nothing while it is held privately.
  act(() => browser.type(threadId, "agent typing"));
  expect(browser.frame(threadId)?.src).toBe(before);
});

test("⌘T opens a new browser tab whose address opens a page of its own beside the current one", async () => {
  const { panel, browser } = await openBrowser();
  const first = browser.view(threadId)?.activeTabId;
  await userEvent.click(within(panel).getByRole("combobox", { name: "Address" }));
  await userEvent.keyboard("{Meta>}t{/Meta}");
  await within(panel).findByRole("tab", { name: "New page", selected: true });
  const address = await within(panel).findByRole("combobox", { name: "Address" });
  await waitFor(() => expect(document.activeElement).toBe(address));
  await userEvent.type(address, "docs.example.com{Enter}");

  await within(panel).findByRole("tab", { name: "docs.example.com", selected: true });
  await waitFor(() => expect(browser.tabsList(threadId)).toHaveLength(2));
  expect(browser.tabsList(threadId).some((tab) => tab.tabId === first)).toBe(true);
  expect(browser.view(threadId)?.url).toBe("https://docs.example.com/");
  // Still one browser tab per page.
  expect(
    within(panel).getAllByRole("tab", { name: /^(localhost:5173|docs\.example\.com)/ }),
  ).toHaveLength(2);
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
