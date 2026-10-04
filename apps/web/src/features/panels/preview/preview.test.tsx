import { failingSubagent } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function openPreview() {
  const app = harness();
  app.play(failingSubagent()).step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  // ⌃⇧P opens the Preview tool in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Preview", selected: true })).toBeTruthy();
  return { app, panel, browser: app.daemon.browser };
}

test("a thread without a dev server says so, and previews one once it is found", async () => {
  const { panel, browser } = await openPreview();
  expect(await within(panel).findByRole("heading", { name: "No dev server yet" })).toBeTruthy();
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
  expect(within(panel).getByText("localhost:3000")).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Open in your browser" })).toBeTruthy();
});

test("a dev server already running is previewed by its port until previewing stops", async () => {
  const { panel, browser } = await openPreview();
  const port = await within(panel).findByRole("textbox", { name: "Dev server port" });
  await userEvent.type(port, "4173");
  await userEvent.click(within(panel).getByRole("button", { name: "Preview" }));

  expect(await within(panel).findByTitle("Preview of http://127.0.0.1:4173")).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([4173]);

  await userEvent.click(
    within(panel).getByRole("button", { name: "Stop previewing · the server keeps running" }),
  );
  expect(await within(panel).findByRole("heading", { name: "No dev server yet" })).toBeTruthy();
  expect(browser.servers("thread-settings")).toEqual([]);
});

test("Open the Browser from an empty preview opens the Browser tool", async () => {
  const { panel } = await openPreview();
  await userEvent.click(await within(panel).findByRole("button", { name: "Open the Browser" }));
  expect(await within(panel).findByRole("tab", { name: "New page", selected: true })).toBeTruthy();
  expect(await within(panel).findByRole("heading", { name: "Open a page" })).toBeTruthy();
});
