import { failingSubagent } from "@ace/fake-daemon";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
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
  expect((within(panel).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe(
    "localhost:3000",
  );
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

test("a dev server opens in a tab of its own, which keeps its address while the server is gone", async () => {
  const { panel, browser } = await openPreview();
  act(() =>
    browser.serve("thread-settings", {
      port: 3000,
      origin: "http://localhost:3000",
      name: "api",
      source: "listener",
    }),
  );
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  await userEvent.click(await within(panel).findByRole("button", { name: "Open in its own tab" }));

  expect(within(panel).getByRole("tab", { name: "api · :3000", selected: true })).toBeTruthy();
  const tabPanel = within(panel).getByRole("tabpanel");
  const address = await within(tabPanel).findByRole("textbox", { name: "Address" });
  expect((address as HTMLInputElement).value).toBe("localhost:3000");
  const tab = within(panel).getByRole("tabpanel");
  expect(within(tab).getByTitle("Preview of http://localhost:3000").getAttribute("src")).toBe(
    "http://localhost:3000",
  );

  await userEvent.click(within(panel).getByRole("button", { name: "Stop previewing this port" }));
  expect(
    await within(panel).findByRole("heading", { name: "Nothing is previewed on port 3000" }),
  ).toBeTruthy();
  expect(
    (within(tabPanel).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value,
  ).toBe("localhost:3000");
  await userEvent.click(within(panel).getByRole("button", { name: "Preview port 3000 again" }));
  expect(await within(tab).findByTitle(/^Preview of http:\/\/127\.0\.0\.1:3000/)).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([3000]);
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real dev server that answers only once `release` is called. */
async function slowServer() {
  const { promise: answered, resolve: release } = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    void answered.then(() => response.end("<h1>web</h1>"));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, release };
}

test("while a dev server's page loads, the frame waits behind a spinner and its tab spins too", async () => {
  const { panel, browser } = await openPreview();
  const { port, release } = await slowServer();
  act(() =>
    browser.serve("thread-settings", {
      port,
      origin: `http://127.0.0.1:${port}`,
      name: "web",
      source: "listener",
    }),
  );
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  expect(
    await within(panel).findByRole("progressbar", { name: `Loading http://127.0.0.1:${port}` }),
  ).toBeTruthy();
  expect(
    within(within(panel).getByRole("tabpanel")).getByText(`Loading 127.0.0.1:${port}…`),
  ).toBeTruthy();
  const tab = within(panel).getByRole("tab", { name: /^Preview/ });
  expect(within(tab).getByRole("status", { name: "Loading" })).toBeTruthy();
  release();
});

test("a dev server that doesn't answer keeps its address, says so and offers Reload", async () => {
  const { panel, browser } = await openPreview();
  act(() =>
    browser.serve("thread-settings", {
      port: 1,
      origin: "http://127.0.0.1:1",
      name: "api",
      source: "listener",
    }),
  );
  await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  const failure = await within(panel).findByRole("alert");
  expect(within(failure).getByRole("heading", { name: "Couldn't reach 127.0.0.1:1" })).toBeTruthy();
  expect((within(panel).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe(
    "127.0.0.1:1",
  );
  await userEvent.click(within(failure).getByRole("button", { name: "Reload" }));
  expect(
    await within(panel).findByRole("heading", { name: "Couldn't reach 127.0.0.1:1" }),
  ).toBeTruthy();
});
