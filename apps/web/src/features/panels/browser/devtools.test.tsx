import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";

/** The cold-start thread with an agent's page in the Browser tool beside it. */
async function openBrowser() {
  browserVideo();
  const app = harness();
  app.play(coldStartReplay()).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole(
    "img",
    { name: "Live view of localhost:5173/settings/devices" },
    { timeout: 10000 },
  );
  return { app, panel, browser: app.daemon.browser };
}

const options = (panel: HTMLElement) =>
  userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));

async function showDeviceToolbar(panel: HTMLElement) {
  await options(panel);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Device toolbar" }));
  await userEvent.click(
    await screen.findByRole("menuitemcheckbox", { name: "Show device toolbar" }),
  );
  await userEvent.keyboard("{Escape}");
  return within(panel).findByRole("toolbar", { name: "Device toolbar" });
}

async function pickDevice(toolbar: HTMLElement, name: string) {
  await userEvent.click(within(toolbar).getByRole("combobox", { name: "Device" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

test("the device toolbar shows the page as a phone, turned on its side, then at a typed size", async () => {
  const { panel, browser } = await openBrowser();
  const toolbar = await showDeviceToolbar(panel);
  await pickDevice(toolbar, "iPhone 16 Pro");
  // The page is told it is that phone: its size, pixel ratio, touch and user agent.
  await waitFor(() =>
    expect(browser.tab(threadId)?.emulation).toMatchObject({
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      userAgent: expect.stringContaining("iPhone"),
    }),
  );
  expect(within(panel).getByRole("group", { name: "Device viewport, 402 by 874" })).toBeTruthy();

  await userEvent.click(within(toolbar).getByRole("button", { name: "Rotate" }));
  await waitFor(() =>
    expect(browser.tab(threadId)?.emulation).toMatchObject({ width: 874, height: 402 }),
  );

  // A typed width makes it Responsive: a desktop page at that size.
  const width = within(toolbar).getByRole("textbox", { name: "Width" });
  await userEvent.clear(width);
  await userEvent.type(width, "500{Enter}");
  await waitFor(() =>
    expect(browser.tab(threadId)?.emulation).toMatchObject({
      width: 500,
      height: 402,
      mobile: false,
      touch: false,
    }),
  );
  expect(within(toolbar).getByRole("combobox", { name: "Device" }).textContent).toContain(
    "Responsive",
  );
  // Responsive mode can be dragged from its edges.
  expect(within(panel).getByRole("separator", { name: "Resize width" })).toBeTruthy();

  await userEvent.click(within(toolbar).getByRole("button", { name: "Close device toolbar" }));
  expect(within(panel).queryByRole("toolbar", { name: "Device toolbar" })).toBeNull();
}, 20_000);

test("a tab keeps its device toolbar when the browser is opened again", async () => {
  const { panel } = await openBrowser();
  await pickDevice(await showDeviceToolbar(panel), "Pixel 9");
  // ⌃⇧B closes the Browser and opens it again.
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Device toolbar" })).toBeNull());
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const toolbar = await screen.findByRole("toolbar", { name: "Device toolbar" });
  expect(within(toolbar).getByRole("combobox", { name: "Device" }).textContent).toContain(
    "Pixel 9",
  );
});

test("an agent's device emulation opens the device toolbar at the agent's device", async () => {
  const { panel, browser } = await openBrowser();
  act(() =>
    browser.tabView(threadId, undefined, {
      emulation: {
        width: 412,
        height: 923,
        deviceScaleFactor: 2.625,
        mobile: true,
        touch: true,
        by: "agent",
      },
    }),
  );
  const toolbar = await within(panel).findByRole("toolbar", { name: "Device toolbar" });
  expect(within(toolbar).getByRole("combobox", { name: "Device" }).textContent).toContain(
    "Pixel 9",
  );
  expect((within(toolbar).getByRole("textbox", { name: "Width" }) as HTMLInputElement).value).toBe(
    "412",
  );
});

test("a device the person chose on another screen shows here and is not undone", async () => {
  const { panel, browser } = await openBrowser();
  const phone = {
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    by: "human" as const,
  };
  act(() => browser.tabView(threadId, undefined, { emulation: phone }));
  const toolbar = await within(panel).findByRole("toolbar", { name: "Device toolbar" });
  expect(within(toolbar).getByRole("combobox", { name: "Device" }).textContent).toContain(
    "iPhone 16 Pro",
  );
  // The page keeps the phone's device: this screen didn't send its own size over it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(browser.tab(threadId)?.emulation).toMatchObject({ width: 402, height: 874 });
  // Closing the toolbar here gives the page this pane's size back.
  await userEvent.click(within(toolbar).getByRole("button", { name: "Close device toolbar" }));
  await waitFor(() => expect(browser.tab(threadId)?.emulation).toBeUndefined());
});

test("zoom steps from the menu and the keys, shows in the address pill, and resets", async () => {
  const { panel, browser } = await openBrowser();
  await options(panel);
  const zoom = await screen.findByRole("group", { name: "Zoom" });
  await userEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(browser.tab(threadId)?.zoom).toBe(1.1));
  await userEvent.keyboard("{Escape}");
  const badge = await within(panel).findByRole("button", { name: "Zoom 110%, reset to 100%" });
  expect(badge.textContent).toBe("110%");

  const page = within(panel).getByRole("application");
  page.focus();
  fireEvent.keyDown(page, { key: "-", code: "Minus", metaKey: true });
  await waitFor(() => expect(browser.tab(threadId)?.zoom).toBeUndefined());
  fireEvent.keyDown(page, { key: "-", code: "Minus", metaKey: true });
  await waitFor(() => expect(browser.tab(threadId)?.zoom).toBe(0.9));
  fireEvent.keyDown(page, { key: "0", code: "Digit0", metaKey: true });
  await waitFor(() => expect(browser.tab(threadId)?.zoom).toBeUndefined());
  await waitFor(() =>
    expect(within(panel).queryByRole("button", { name: /^Zoom \d+%/ })).toBeNull(),
  );
});

test("right-clicking the page offers browser commands; View page source shows the source", async () => {
  const { panel } = await openBrowser();
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  const menu = await screen.findByRole("menu");
  for (const name of ["Back", "Forward", "Reload", "Copy", "Paste", "Take a screenshot"])
    expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
  // Developer tools open for the desktop app's own pages; here the item says why not.
  expect(
    within(menu)
      .getByRole("menuitem", { name: /Inspect/ })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "View page source" }));
  const dialog = await screen.findByRole("dialog", { name: /Source of/ });
  expect(within(dialog).getByLabelText("Page source").textContent).toContain(
    "<title>Synthetic fixture page</title>",
  );
});

test("History lists the pages this thread's browser showed, and search narrows it", async () => {
  const { panel, browser } = await openBrowser();
  const address = () =>
    (within(panel).getByRole("combobox", { name: "Address" }) as HTMLInputElement).value;
  act(() => {
    browser.navigate(threadId, "https://docs.example/guide");
  });
  await waitFor(() => expect(address()).toContain("docs.example"));
  act(() => {
    browser.navigate(threadId, "https://shop.example/cart");
  });
  await waitFor(() => expect(address()).toContain("shop.example"));
  await options(panel);
  await userEvent.click(await screen.findByRole("menuitem", { name: "History" }));
  const dialog = await screen.findByRole("dialog", { name: "History" });
  // Both pages, newest first.
  await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(2));
  expect(within(dialog).getAllByRole("listitem")[0]?.textContent).toContain("shop.example");
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Search history" }), "guide");
  await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(1));
  expect(within(dialog).getByRole("listitem").textContent).toContain("docs.example");
});

test("Clear browsing data asks first, then clears and empties the thread's history", async () => {
  const { panel } = await openBrowser();
  await options(panel);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Clear browsing data…" }));
  const confirm = await screen.findByRole("dialog", { name: "Clear browsing data?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Clear data" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Clear browsing data?" })).toBeNull(),
  );
  await options(panel);
  await userEvent.click(await screen.findByRole("menuitem", { name: "History" }));
  const history = await screen.findByRole("dialog", { name: "History" });
  expect(within(history).getByText("No history yet")).toBeTruthy();
});

test("right-clicking a link in the page offers to open it in a new tab, and an image to copy or save", async () => {
  const { panel, browser } = await openBrowser();
  browser.contextTarget = { link: "https://docs.example/next", image: "https://cdn.example/p.png" };
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  const menu = await screen.findByRole("menu");
  expect(await within(menu).findByRole("menuitem", { name: "Copy image" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "Save image as…" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Open link in new tab" }));
  await waitFor(() =>
    expect(browser.tabsList(threadId).map((tab) => tab.url)).toContain("https://docs.example/next"),
  );
});

test("right-clicking plain page content offers no link or image commands", async () => {
  const { panel, browser } = await openBrowser();
  browser.contextTarget = {};
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  const menu = await screen.findByRole("menu");
  await within(menu).findByRole("menuitem", { name: "Reload" });
  expect(within(menu).queryByRole("menuitem", { name: "Open link in new tab" })).toBeNull();
  expect(within(menu).queryByRole("menuitem", { name: "Copy image" })).toBeNull();
});
