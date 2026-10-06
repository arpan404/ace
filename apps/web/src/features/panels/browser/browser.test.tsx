import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

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

const address = (panel: HTMLElement) => within(panel).getByRole("combobox", { name: "Address" });

async function goTo(panel: HTMLElement, text: string) {
  const field = await within(panel).findByRole("combobox", { name: "Address" });
  await userEvent.clear(field);
  await userEvent.type(field, `${text}{Enter}`);
}

test("the browser shows the page an agent is driving, names the agent, and follows its frames", async () => {
  const { panel, browser, script } = await openBrowser(
    coldStartReplay(),
    "/t/thread-cold-start",
    "turn-2",
  );
  expect(await within(panel).findByText("resume-sweep")).toBeTruthy();
  expect(within(panel).getByText("is using this page", { exact: false })).toBeTruthy();
  const frame = within(panel).getByRole("img", {
    name: "Live view of localhost:5173/settings/devices",
  });
  const first = frame.getAttribute("src");
  act(() => browser.type("thread-cold-start", "iPhone 16 Pro Max"));
  await waitFor(() => expect(frame.getAttribute("src")).not.toBe(first));
  expect(decodeURIComponent(frame.getAttribute("src") ?? "")).toContain("iPhone 16 Pro Max");
  // Once resume-sweep's browser call ends, the thread's own agent holds the page.
  await act(async () => script.runThrough("audit-done"));
  expect(await within(panel).findByText("Claude Code")).toBeTruthy();
  // The bar shows the page's address; there is no lock or pretend window around it.
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:5173/settings/devices");
});

test("taking control forwards clicks, wheel and keys, sizes the page to the panel, and hands back", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  // Before you take control, the page is a picture: nothing is forwarded.
  expect(within(panel).queryByRole("application")).toBeNull();

  await userEvent.click(within(panel).getByRole("button", { name: "Take control" }));
  await within(panel).findByText("have control", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
  // jsdom lays every element out 800px wide; the page starts at 760 and follows the panel.
  await waitFor(() => expect(browser.frame("thread-cold-start")?.width).toBe(800));

  const page = within(panel).getByRole("application", {
    name: "Control localhost:5173/settings/devices",
  });
  fireEvent.mouseDown(page, { clientX: 10, clientY: 20 });
  fireEvent.mouseUp(page, { clientX: 10, clientY: 20 });
  fireEvent.wheel(page, { clientX: 10, clientY: 20, deltaY: 120 });
  page.focus();
  await userEvent.keyboard("a");
  await waitFor(() =>
    expect(
      browser.wireInputs.map(({ input }) => `${input.kind}:${"event" in input ? input.event : ""}`),
    ).toEqual(["mouse:mousePressed", "mouse:mouseReleased", "scroll:", "key:keyDown", "key:keyUp"]),
  );
  expect(
    browser.wireInputs.filter(({ input }) => input.kind === "key").map(({ input }) => input),
  ).toEqual([
    { kind: "key", event: "keyDown", key: "a", code: "KeyA", modifiers: 0, text: "a" },
    { kind: "key", event: "keyUp", key: "a", code: "KeyA", modifiers: 0 },
  ]);
  // The agent's typing is ignored while you hold control.
  const held = within(panel).getByRole("img").getAttribute("src");
  act(() => browser.type("thread-cold-start", "something else"));
  expect(within(panel).getByRole("img").getAttribute("src")).toBe(held);

  await userEvent.click(
    within(panel).getAllByRole("button", { name: "Hand back" })[0] as HTMLElement,
  );
  await within(panel).findByText("is using this page", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("agent");
});

test("⌃⇧C takes and hands back control from the keyboard", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("human"));
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("agent"));
});

test("an address takes the page from the agent and opens; Back returns; a dead port says why", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });

  await goTo(panel, "docs.example.com/guide");
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://docs.example.com/guide"),
  );
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
  expect(await within(panel).findByRole("tab", { name: "docs.example.com" })).toBeTruthy();

  const retainedFrame = browser.frame("thread-cold-start")?.sequence;
  await goTo(panel, "localhost:4321");
  const failure = await within(panel).findByRole("alert");
  expect(within(failure).getByText("This site can't be reached")).toBeTruthy();
  expect(within(failure).getByText("ERR_CONNECTION_REFUSED")).toBeTruthy();
  // The failed address stays in the bar, with Reload beside the explanation.
  expect((address(panel) as HTMLInputElement).value).toBe("localhost:4321");
  expect(within(failure).getByRole("button", { name: "Reload" })).toBeTruthy();

  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect((address(panel) as HTMLInputElement).value).toBe("docs.example.com/guide"),
  );
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(browser.view("thread-cold-start")?.url).toBe("https://docs.example.com/guide");
  expect(browser.frame("thread-cold-start")?.sequence).toBe(retainedFrame);
});

test("Back dismisses a failed first address even when the document has no earlier entry", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await userEvent.click(within(panel).getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(browser.frame("thread-cold-start")?.width).toBe(800));
  const retainedFrame = browser.frame("thread-cold-start")?.sequence;
  await goTo(panel, "localhost:4321");
  await within(panel).findByRole("alert");
  const back = within(panel).getByRole("button", { name: "Back" });
  expect(back.getAttribute("aria-disabled")).not.toBe("true");
  await userEvent.click(back);
  await waitFor(() =>
    expect(address(panel).getAttribute("value")).toBe("localhost:5173/settings/devices"),
  );
  expect(within(panel).queryByRole("alert")).toBeNull();
  expect(browser.frame("thread-cold-start")?.sequence).toBe(retainedFrame);
});

test("document Back and Forward follow successful navigation and Reload refreshes the current page", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await goTo(panel, "docs.example.com/guide");
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://docs.example.com/guide"),
  );
  await goTo(panel, "example.org/next");
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://example.org/next"),
  );
  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://docs.example.com/guide"),
  );
  await waitFor(() => expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide"));
  const forward = within(panel).getByRole("button", { name: "Forward" });
  await waitFor(() => expect(forward.getAttribute("aria-disabled")).not.toBe("true"));
  await userEvent.click(forward);
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://example.org/next"),
  );
  const sequence = browser.frame("thread-cold-start")?.sequence ?? 0;
  await userEvent.click(within(panel).getByRole("button", { name: "Reload" }));
  await waitFor(() =>
    expect(browser.frame("thread-cold-start")?.sequence).toBeGreaterThan(sequence),
  );
  expect(browser.view("thread-cold-start")?.url).toBe("https://example.org/next");
});

test("Back traverses a failed navigation that replaced the document and clears the error", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
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
  expect(browser.view("thread-cold-start")?.url).toBe("https://example.org/timeout");
  await userEvent.click(within(panel).getByRole("button", { name: "Back" }));
  await waitFor(() =>
    expect(browser.view("thread-cold-start")?.url).toBe("https://docs.example.com/guide"),
  );
  await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
  expect(address(panel).getAttribute("value")).toBe("docs.example.com/guide");
});

test("text that isn't an address is refused instead of searched", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await goTo(panel, "how to center a div");
  expect(await within(panel).findByText(/That isn't an address/)).toBeTruthy();
  expect(browser.view("thread-cold-start")?.url).toBe("localhost:5173/settings/devices");
  expect(browser.view("thread-cold-start")?.controller).toBe("agent");
});

test("a thread's first page downloads the browser with progress, then opens the address", async () => {
  const { panel, browser } = await openBrowser(failingSubagent(), "/t/thread-settings");
  expect(await within(panel).findByRole("heading", { name: "Open a page" })).toBeTruthy();
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
});

test("the page lives in one browser tab; another offers to load its own address there", async () => {
  const { panel } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await goTo(panel, "docs.example.com");
  await within(panel).findByRole("tab", { name: "docs.example.com", selected: true });

  // A new tab from the launcher's address bar takes an address of its own.
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const launcherAddress = await within(panel).findByRole("combobox", { name: "Address" });
  await userEvent.type(launcherAddress, "example.org{Enter}");
  await within(panel).findByRole("tab", { name: "example.org", selected: true });
  await waitFor(() => expect((address(panel) as HTMLInputElement).value).toBe("example.org"));

  // The first tab still remembers docs.example.com, and can take the page back.
  await userEvent.click(within(panel).getByRole("tab", { name: "docs.example.com" }));
  expect(
    await within(panel).findByRole("heading", { name: "The page is in another tab" }),
  ).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Load it here" }));
  await waitFor(() =>
    expect(within(panel).queryByRole("heading", { name: "The page is in another tab" })).toBeNull(),
  );
  expect((address(panel) as HTMLInputElement).value).toBe("docs.example.com");
});

test("leaving the browser while holding control hands the page back to the agent", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await userEvent.click(within(panel).getByRole("button", { name: "Take control" }));
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("human"));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("agent"));
});

/** Hide or show the page, as switching tabs or minimising the window does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("while the window is hidden the browser stops pulling frames, and shows the latest once shown", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  const page = () =>
    within(panel).getByRole("img", { name: "Live view of localhost:5173/settings/devices" });
  try {
    act(() => visibility("hidden"));
    act(() => browser.type("thread-cold-start", "Pixel 9"));
    await waitFor(() =>
      expect(decodeURIComponent(page().getAttribute("src") ?? "")).toContain("Pixel 9"),
    );
    // That frame is not acknowledged while hidden, so the browser sends no more.
    act(() => browser.type("thread-cold-start", "Galaxy S25"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decodeURIComponent(page().getAttribute("src") ?? "")).not.toContain("Galaxy S25");
    act(() => visibility("visible"));
    await waitFor(() =>
      expect(decodeURIComponent(page().getAttribute("src") ?? "")).toContain("Galaxy S25"),
    );
  } finally {
    visibility("visible");
  }
});

test("a tab whose page has closed (as after a restart) names that page and opens it again", async () => {
  const { panel, browser } = await openBrowser();
  await within(panel).findByText("is using this page", { exact: false });
  await goTo(panel, "docs.example.com/guide");
  await within(panel).findByRole("tab", { name: "docs.example.com", selected: true });

  // The thread's page goes away while the tab keeps its address, as a restart leaves it.
  await userEvent.click(within(panel).getByRole("button", { name: "Browser options" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Close the thread's page" }));
  await waitFor(() => expect(browser.view("thread-cold-start")?.closed).toBe(true));

  // Title, address and page all name the same page: no "Open a page" under its title.
  expect(within(panel).getByRole("tab", { name: "docs.example.com" })).toBeTruthy();
  expect(await within(panel).findByRole("heading", { name: "docs.example.com" })).toBeTruthy();
  expect(within(panel).queryByRole("heading", { name: "Open a page" })).toBeNull();
  expect((address(panel) as HTMLInputElement).value).toBe("docs.example.com/guide");

  await userEvent.click(within(panel).getByRole("button", { name: "Open again" }));
  await waitFor(() =>
    expect(browser.view("thread-cold-start")).toMatchObject({
      closed: false,
      url: "https://docs.example.com/guide",
    }),
  );
});
