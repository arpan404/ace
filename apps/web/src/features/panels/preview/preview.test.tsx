import { failingSubagent } from "@ace/fake-daemon";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { configure, act, screen, waitFor, within } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

async function openPreview(app = harness()) {
  app.play(failingSubagent()).step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  // ⌃⇧P opens the Preview tool in the side panel.
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  return { app, panel, browser: app.daemon.browser };
}

test("with no dev server previewed, Preview suggests the ones found, and previews one once it runs", async () => {
  const { panel, browser } = await openPreview();
  expect(await within(panel).findByRole("heading", { name: "Suggested" })).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "Preview", selected: true })).toBeTruthy();
  const port = await answeringServer();
  browser.serve("thread-settings", {
    port,
    origin: `http://127.0.0.1:${port}`,
    name: "api",
    source: "listener",
  });
  // Bringing the page back into view polls discovery immediately, even while tabs stay mounted.
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const frame = await within(panel).findByTitle(`Preview of http://127.0.0.1:${port}`);
  expect(frame.getAttribute("src")).toBe(`http://127.0.0.1:${port}`);
  // Its tab now says which server it shows.
  expect(
    await within(panel).findByRole("tab", { name: new RegExp(`^api · :${port}`), selected: true }),
  ).toBeTruthy();
  expect((within(panel).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value).toBe(
    `127.0.0.1:${port}`,
  );
  expect(within(panel).getByRole("button", { name: "Open in your browser" })).toBeTruthy();
});

test("a dev server already running is previewed by its port until previewing stops", async () => {
  const { panel, browser } = await openPreview();
  const running = await answeringServer();
  const port = await within(panel).findByRole("textbox", { name: "Dev server port" });
  await userEvent.type(port, String(running));
  await userEvent.click(within(panel).getByRole("button", { name: "Preview" }));

  expect(await within(panel).findByTitle(`Preview of http://127.0.0.1:${running}`)).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([running]);

  await userEvent.click(await within(panel).findByRole("button", { name: "Stop previewing" }));
  await waitFor(() => expect(browser.servers("thread-settings")).toEqual([]));
  expect(await within(panel).findByRole("heading", { name: "Suggested" })).toBeTruthy();
});

test("an empty preview lists the detected dev servers above the manual port, and one click previews it", async () => {
  const { panel, browser } = await openPreview();
  const detected = await within(panel).findByRole("list", { name: "Detected dev servers" });
  const port = within(panel).getByRole("textbox", { name: "Dev server port" });
  expect(detected.compareDocumentPosition(port) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(within(detected).getByRole("button", { name: /^Next\.js/ }));
  expect(
    await within(panel).findByTitle("Preview of http://127.0.0.1:3000", undefined, {
      timeout: 10000,
    }),
  ).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([3000]);
}, 20_000);

test("Open the Browser from an empty preview opens the Browser tool", async () => {
  const { panel } = await openPreview();
  await userEvent.click(await within(panel).findByRole("button", { name: "Open the Browser" }));
  expect(await within(panel).findByRole("tab", { name: "Browser", selected: true })).toBeTruthy();
  // Its start page is the address bar, with no narration.
  expect(await within(panel).findByRole("combobox", { name: "Address" })).toBeTruthy();
});

test("a dev server opens in a tab of its own, which keeps its address while the server is gone", async () => {
  const app = harness();
  const port = await answeringServer();
  const origin = `http://127.0.0.1:${port}`;
  app.daemon.browser.serve("thread-settings", { port, origin, name: "api", source: "listener" });
  const { panel, browser } = await openPreview(app);
  await userEvent.click(await within(panel).findByRole("button", { name: "Open in its own tab" }));

  expect(within(panel).getByRole("tab", { name: `api · :${port}`, selected: true })).toBeTruthy();
  const tabPanel = within(panel).getByRole("tabpanel");
  const address = await within(tabPanel).findByRole("textbox", { name: "Address" });
  expect((address as HTMLInputElement).value).toBe(`127.0.0.1:${port}`);
  const tab = within(panel).getByRole("tabpanel");
  expect((await within(tab).findByTitle(`Preview of ${origin}`)).getAttribute("src")).toBe(origin);

  await userEvent.click(within(panel).getByRole("button", { name: "Stop previewing this port" }));
  expect(
    await within(panel).findByRole("heading", { name: `Nothing is previewed on port ${port}` }),
  ).toBeTruthy();
  expect(
    (within(tabPanel).getByRole("textbox", { name: "Address" }) as HTMLInputElement).value,
  ).toBe(`localhost:${port}`);
  await userEvent.click(within(panel).getByRole("button", { name: `Preview port ${port} again` }));
  expect(await within(tab).findByTitle(`Preview of ${origin}`)).toBeTruthy();
  expect(browser.servers("thread-settings").map((server) => server.port)).toEqual([port]);
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A real dev server that answers at once. */
async function answeringServer() {
  const server = createServer((_request, response) => response.end("<h1>api</h1>"));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

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
  const { port, release } = await slowServer();
  const app = harness();
  app.daemon.browser.serve("thread-settings", {
    port,
    origin: `http://127.0.0.1:${port}`,
    name: "web",
    source: "listener",
  });
  const { panel } = await openPreview(app);
  expect(
    await within(panel).findByRole("progressbar", { name: `Loading http://127.0.0.1:${port}` }),
  ).toBeTruthy();
  expect(
    within(within(panel).getByRole("tabpanel")).getByText(`Loading 127.0.0.1:${port}…`),
  ).toBeTruthy();
  // The tab is titled after the server it shows.
  const tab = await within(panel).findByRole("tab", { name: new RegExp(`^web · :${port}`) });
  expect(within(tab).getByRole("status", { name: "Loading" })).toBeTruthy();
  release();
});

test("a dev server that doesn't answer isn't held open: Preview goes back to its suggestions", async () => {
  const app = harness();
  app.daemon.browser.serve("thread-settings", {
    port: 1,
    origin: "http://127.0.0.1:1",
    name: "api",
    source: "listener",
  });
  const { panel } = await openPreview(app);
  expect(await within(panel).findByText("Nothing answered at localhost:1")).toBeTruthy();
  expect(within(panel).getByRole("heading", { name: "Suggested" })).toBeTruthy();
  // No failed page in its place, and the server stays one click away.
  expect(within(panel).queryByRole("heading", { name: "Couldn't reach 127.0.0.1:1" })).toBeNull();
  const suggested = within(panel).getByRole("list", { name: "Detected dev servers" });
  expect(within(suggested).getByRole("button", { name: /^api/ })).toBeTruthy();
  expect(within(panel).getByRole("tab", { name: "Preview", selected: true })).toBeTruthy();
});
