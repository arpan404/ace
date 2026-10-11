import { failingSubagent } from "@ace/fake-daemon";
import { createServer } from "node:http";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

async function openPreview() {
  const app = harness();
  app.play(failingSubagent()).step();
  await app.open("/t/thread-settings");
  await screen.findByRole("heading", { level: 1, name: "Migrate settings schema" });
  await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  return { panel, browser: app.daemon.browser };
}

/** A dev server the daemon previews, shown in the Preview tab. */
async function showServer() {
  const opened = await openPreview();
  act(() =>
    opened.browser.serve("thread-settings", {
      port: 3000,
      origin: "http://localhost:3000",
      name: "api",
      source: "listener",
    }),
  );
  await userEvent.click(within(opened.panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(opened.panel).getByRole("tab", { name: "Preview" }));
  return opened;
}

/** What the gateway's refusal page in the frame posts to ace. */
function gatewayRefuses(
  frame: HTMLElement,
  status: number,
  reason: string,
  origin = "http://localhost:3000",
) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "ace-preview.status", status, reason },
        origin,
        source: (frame as HTMLIFrameElement).contentWindow,
      }),
    ),
  );
}

const frameTitle = "Preview of http://localhost:3000";

test("a port the daemon won't preview says why, not just that it couldn't", async () => {
  const { panel, browser } = await openPreview();
  browser.refusePreviews("preview_owned_by_another_thread");
  await userEvent.type(
    await within(panel).findByRole("textbox", { name: "Dev server port" }),
    "4173",
  );
  await userEvent.click(within(panel).getByRole("button", { name: "Preview" }));
  expect((await within(panel).findByRole("alert")).textContent).toBe(
    "Another thread already previews port 4173. Stop it there first.",
  );
});

test("a preview the daemon won't sign in shows its reason, and Reload signs in again", async () => {
  const { promise: probed, resolve: responded } = Promise.withResolvers<void>();
  const server = createServer((_request, response) => {
    response.end("<h1>Ready</h1>", responded);
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const title = `Preview of ${origin}`;
  const opened = await openPreview();
  opened.browser.refusePreviews("forbidden");
  act(() =>
    opened.browser.serve("thread-settings", {
      port: address.port,
      origin,
      name: "api",
      source: "listener",
    }),
  );
  await userEvent.click(within(opened.panel).getByRole("tab", { name: /^Changes/ }));
  await userEvent.click(within(opened.panel).getByRole("tab", { name: "Preview" }));
  const failure = await within(opened.panel).findByRole("alert");
  expect(
    within(failure).getByRole("heading", { name: "This device can't open previews" }),
  ).toBeTruthy();
  expect(within(opened.panel).queryByTitle(title)).toBeNull();

  opened.browser.refusePreviews(undefined);
  await userEvent.click(within(failure).getByRole("button", { name: "Reload" }));
  expect(await within(opened.panel).findByTitle(title)).toBeTruthy();
  await probed;
  await waitFor(() => expect(within(opened.panel).queryByRole("alert")).toBeNull());
});

test("a frame whose sign-in doesn't stick signs in once more, then says the browser dropped it", async () => {
  const { panel } = await showServer();
  const first = await within(panel).findByTitle(frameTitle);
  // Reports from another origin are not the gateway's and change nothing.
  gatewayRefuses(first, 401, "signed_out", "http://localhost:9999");
  expect(within(panel).getByTitle(frameTitle)).toBe(first);

  gatewayRefuses(first, 401, "signed_out");
  await waitFor(() => expect(within(panel).getByTitle(frameTitle)).not.toBe(first));
  await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());

  gatewayRefuses(within(panel).getByTitle(frameTitle), 401, "signed_out");
  const failure = await within(panel).findByRole("alert");
  expect(
    within(failure).getByRole("heading", { name: "The preview didn't keep its sign-in" }),
  ).toBeTruthy();
  expect(within(failure).getByText(/never received its sign-in cookie/)).toBeTruthy();
});

test("a dev server that stopped behind the gateway is named, without signing in again", async () => {
  const { panel } = await showServer();
  const frame = await within(panel).findByTitle(frameTitle);
  gatewayRefuses(frame, 502, "upstream_unavailable");
  const failure = await within(panel).findByRole("alert");
  expect(
    within(failure).getByRole("heading", { name: "Nothing answered on port 3000" }),
  ).toBeTruthy();
  expect(within(panel).getByTitle(frameTitle)).toBe(frame);
});

test("Open in your browser signs a new tab in at the click, and a refusal closes it and says why", async () => {
  const { panel, browser } = await showServer();
  await within(panel).findByTitle(frameTitle);
  const tab = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, "open").mockImplementation(() => tab as unknown as Window);

  await userEvent.click(within(panel).getByRole("button", { name: "Open in your browser" }));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("http://localhost:3000"));
  expect(tab.opener).toBeNull();

  browser.refusePreviews("forbidden");
  await userEvent.click(within(panel).getByRole("button", { name: "Open in your browser" }));
  expect(await screen.findByText("Couldn't open the page")).toBeTruthy();
  expect(screen.getByText(/This device can't open previews/)).toBeTruthy();
  expect(tab.close).toHaveBeenCalledTimes(1);
});
