import { coldStartReplay, failingSubagent, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openPreview(
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
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  return { app, panel, browser: app.daemon.browser, script };
}

test("the preview names the agent of this thread whose browser call is running", async () => {
  const { panel, script } = await openPreview(coldStartReplay(), "/t/thread-cold-start", "turn-2");
  const status = async (name: string) =>
    (await within(panel).findByText(name, { exact: false })).closest("span")?.textContent;
  expect(await status("resume-sweep")).toContain("is controlling the browser");

  // Once resume-sweep's browser call ends, the thread's own agent holds the page.
  await act(async () => script.runThrough("audit-done"));
  expect(await status("Claude Code")).toContain("is controlling the browser");
});

test("the preview shows the page an agent is driving and follows its frames", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByText("is controlling the browser", { exact: false });
  const frame = within(panel).getByRole("img", {
    name: "Live view of localhost:5173/settings/devices",
  });
  const first = frame.getAttribute("src");
  expect(decodeURIComponent(first ?? "")).toContain("iPhone 16 Pro");

  act(() => browser.type("thread-cold-start", "iPhone 16 Pro Max"));
  await waitFor(() => expect(frame.getAttribute("src")).not.toBe(first));
  expect(decodeURIComponent(frame.getAttribute("src") ?? "")).toContain("iPhone 16 Pro Max");
});

test("the agent's browser is sized to the pane, so the page shows at full size", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByText("is controlling the browser", { exact: false });
  // jsdom lays every element out 800px wide; the browser starts at 760.
  await waitFor(() => expect(browser.frame("thread-cold-start")?.width).toBe(800));
  const page = within(panel).getByRole("img", {
    name: "Live view of localhost:5173/settings/devices",
  });
  expect(decodeURIComponent(page.getAttribute("src") ?? "")).toContain('width="800"');
});

test("taking control pauses the agent, forwards clicks and keys, and hands back", async () => {
  const { panel, browser } = await openPreview();
  // Before you take control, the page is a picture: nothing is forwarded.
  expect(within(panel).queryByRole("application")).toBeNull();

  await userEvent.click(await within(panel).findByRole("button", { name: /Take control/ }));
  await within(panel).findByText("have control · the agent is paused", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");

  const page = within(panel).getByRole("application", {
    name: "Control localhost:5173/settings/devices",
  });
  fireEvent.mouseDown(page, { clientX: 10, clientY: 20 });
  fireEvent.mouseUp(page, { clientX: 10, clientY: 20 });
  page.focus();
  await userEvent.keyboard("a");
  await waitFor(() =>
    expect(browser.inputs.map(({ input }) => input.kind + ":" + input.event)).toEqual([
      "mouse:mousePressed",
      "mouse:mouseReleased",
      "key:keyDown",
    ]),
  );

  // Typing by the agent is ignored while you hold control.
  const held = within(panel).getByRole("img").getAttribute("src");
  act(() => browser.type("thread-cold-start", "something else"));
  expect(within(panel).getByRole("img").getAttribute("src")).toBe(held);

  await userEvent.click(within(panel).getByRole("button", { name: /Hand back/ }));
  await within(panel).findByText("is controlling the browser", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("agent");
});

test("⌃⇧C takes and hands back control from the keyboard", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByRole("button", { name: /Take control/ });
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await within(panel).findByRole("button", { name: /Hand back/ });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await within(panel).findByRole("button", { name: /Take control/ });
});

test("Open full view shows the live page large, with the same control", async () => {
  const { panel, browser } = await openPreview();
  await userEvent.click(await within(panel).findByRole("button", { name: "Open full view" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Live view of localhost:5173/settings/devices",
  });
  await userEvent.click(within(dialog).getByRole("button", { name: /Take control/ }));
  await within(dialog).findByRole("button", { name: /Hand back/ });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
});

test("a thread with neither a browser nor a dev server says so, and previews a server once found", async () => {
  const { panel, browser } = await openPreview(failingSubagent(), "/t/thread-settings");
  expect(await within(panel).findByText("Nothing to preview")).toBeTruthy();

  browser.serve("thread-settings", {
    port: 3000,
    origin: "http://localhost:3000",
    name: "api",
    source: "listener",
  });
  // Coming back to the tab reads the dev servers again.
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  const frame = await within(panel).findByTitle("Preview of http://localhost:3000");
  expect(frame.getAttribute("src")).toBe("http://localhost:3000");
  expect(within(panel).getByRole("link", { name: "Open in browser" }).getAttribute("href")).toBe(
    "http://localhost:3000",
  );
});

test("Open a browser starts one for the thread and shows its page live", async () => {
  const { panel, browser } = await openPreview(failingSubagent(), "/t/thread-settings");
  await userEvent.click(await within(panel).findByRole("button", { name: "Open a browser" }));
  expect(await within(panel).findByRole("img", { name: "Live view of about:blank" })).toBeTruthy();
  expect(browser.view("thread-settings")?.closed).toBe(false);
});

test("the first browser shows the daemon's Chromium download until it is ready", async () => {
  const { panel, browser } = await openPreview(failingSubagent(), "/t/thread-settings");
  browser.requireDownload(150_000_000);
  await userEvent.click(await within(panel).findByRole("button", { name: "Open a browser" }));

  expect(
    await within(panel).findByRole("heading", { name: "Getting the browser ready" }),
  ).toBeTruthy();
  const bar = within(panel).getByRole("progressbar", { name: "Downloading the browser" });
  expect(bar.getAttribute("aria-valuenow")).toBe("40");
  expect(bar.getAttribute("aria-valuetext")).toBe("Downloading the browser · 40%");
  // Nothing else to do meanwhile: the port form waits until the browser is ready.
  expect(within(panel).queryByRole("form", { name: "Preview a dev server" })).toBeNull();
  act(() => browser.finishDownload());
  expect(await within(panel).findByRole("img", { name: "Live view of about:blank" })).toBeTruthy();
  expect(within(panel).queryByText(/Downloading the browser/)).toBeNull();
});

test("a dev server already running is previewed by its port until Stop preview", async () => {
  const { panel, browser } = await openPreview(failingSubagent(), "/t/thread-settings");
  const port = await within(panel).findByRole("textbox", { name: "Dev server port" });
  await userEvent.type(port, "4173");
  await userEvent.click(within(panel).getByRole("button", { name: "Preview" }));

  expect(await within(panel).findByTitle("Preview of http://127.0.0.1:4173")).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([4173]);

  await userEvent.click(within(panel).getByRole("button", { name: "Stop preview" }));
  expect(await within(panel).findByRole("heading", { name: "Nothing to preview" })).toBeTruthy();
  expect(browser.servers("thread-settings")).toEqual([]);
});

test("leaving the preview while holding control hands the browser back to the agent", async () => {
  const { panel, browser } = await openPreview();
  await userEvent.click(await within(panel).findByRole("button", { name: /Take control/ }));
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("human"));
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await waitFor(() => expect(browser.view("thread-cold-start")?.controller).toBe("agent"));
});

/** Hide or show the page, as switching tabs or minimising the window does. */
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("while the window is hidden the preview stops pulling frames, and shows the latest once shown", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByText("is controlling the browser", { exact: false });
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
