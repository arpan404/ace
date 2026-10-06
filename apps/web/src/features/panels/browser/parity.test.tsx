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
  await within(panel).findByText("is using this page", { exact: false });
  return { app, panel, browser: app.daemon.browser };
}

test("the agent's tabs show by name; switching and closing one is what the daemon's browser does", async () => {
  const { panel, browser } = await openBrowser();
  act(() => browser.tabOpen(threadId, "https://status.example/"));
  const strip = await within(panel).findByRole("tablist", { name: "Agent tabs" });
  const tabs = within(strip).getAllByRole("tab");
  expect(tabs).toHaveLength(browser.tabsList(threadId).length);
  // The agent's newest tab is the one it shows.
  expect(within(strip).getByRole("tab", { selected: true })).toBe(tabs.at(-1));

  await userEvent.click(tabs[0]!);
  await waitFor(() =>
    expect(browser.view(threadId)?.activeTabId).toBe(browser.tabsList(threadId)[0]?.tabId),
  );
  // Switching needs the person's lease, so it took control first.
  expect(browser.view(threadId)?.controller).toBe("human");

  const [first] = browser.tabsList(threadId);
  await userEvent.click(within(strip).getAllByRole("button", { name: /^Close / })[0]!);
  await waitFor(() =>
    expect(browser.tabsList(threadId).map((tab) => tab.tabId)).not.toContain(first?.tabId),
  );
  // With one tab left there is nothing to switch between, so the strip goes.
  const left = () =>
    within(panel).queryByRole("tablist", { name: "Agent tabs" })?.querySelectorAll('[role="tab"]')
      .length ?? 1;
  await waitFor(() => expect(left()).toBe(tabs.length - 1));
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

  await userEvent.click(within(panel).getByRole("button", { name: "Take over privately" }));

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
  await userEvent.click(within(panel).getByRole("button", { name: "Take over privately" }));
  await waitFor(() => expect(browser.view(threadId)?.takeoverMode).toBe("private"));
  const before = browser.frame(threadId)?.src;

  // Leave the page: the browser's workspace tab closes and its view unmounts.
  await userEvent.click(within(panel).getByRole("button", { name: /^Close localhost/ }));
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: "Take over privately" })).toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(browser.view(threadId)?.controller).toBe("human");
  expect(browser.view(threadId)?.takeoverMode).toBe("private");
  // An agent acting on the page changes nothing while it is held privately.
  act(() => browser.type(threadId, "agent typing"));
  expect(browser.frame(threadId)?.src).toBe(before);
});
