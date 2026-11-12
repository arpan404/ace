import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const linear = {
  id: "linear",
  name: "Linear",
  url: "https://mcp.linear.app/mcp",
  sign_in: ["oauth", "token"],
  notes: "An API key also works.",
};

function seed(api: FakeSpadeApi) {
  withEndpoint(api);
  api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  api.connectors.catalogue.push(linear);
}

/** The browser tab a sign-in opens in, as `window.open` hands it back. */
function browserTab() {
  const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return tab;
}

const connectors = async () =>
  within(
    (await screen.findByRole("heading", { name: "Connectors" })).closest("section") ??
      document.body,
  );

async function openCatalogue() {
  await userEvent.click(await screen.findByRole("button", { name: "Connect an app" }));
  return within(await screen.findByRole("dialog", { name: "Connect an app" }));
}

test("signing in to an app opens its page in the browser, and its row follows the sign-in", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const tab = browserTab();
  const dialog = await openCatalogue();
  await userEvent.click(dialog.getByRole("button", { name: "Sign in for Linear" }));
  await waitFor(() =>
    expect(tab.location.replace).toHaveBeenCalledWith(
      "https://auth.example/authorize?client=linear",
    ),
  );
  expect(spade.sent("POST", "/v1/connectors")).toEqual([{ catalogue: "linear" }]);
  const section = await connectors();
  expect(await section.findByText("Waiting for you to finish signing in")).toBeTruthy();
  spade.connectors.finishSignIn("linear", "me@example.com");
  expect(await section.findByText("Connected as me@example.com")).toBeTruthy();
});

test("a token goes to Spade in one request, and Disconnect removes the app", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const dialog = await openCatalogue();
  await userEvent.click(dialog.getByRole("button", { name: "Use a token for Linear" }));
  await userEvent.type(dialog.getByLabelText("Token for Linear"), "lin-key-1");
  await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(spade.sent("POST", "/v1/connectors")).toEqual([
    { catalogue: "linear", token: "lin-key-1" },
  ]);
  const section = await connectors();
  expect(await section.findByText("Connected")).toBeTruthy();
  await userEvent.click(section.getByRole("button", { name: "Disconnect Linear" }));
  await waitFor(() => expect(spade.sent("DELETE", "/v1/connectors/linear")).toHaveLength(1));
  await waitFor(() => expect(section.queryByText("Linear")).toBeNull());
});

test("a server added by address reaches local addresses only when the person says it is theirs", async () => {
  const { spade } = await spadeApp("/settings/spade", seed);
  const dialog = await openCatalogue();
  await userEvent.type(
    dialog.getByRole("textbox", { name: "Another server" }),
    "http://192.168.1.20:8080/mcp",
  );
  const mine = dialog.getByRole("switch", { name: "On my own machine or network" });
  expect(checked(mine)).toBe(false);
  await userEvent.click(mine);
  await userEvent.click(dialog.getByRole("button", { name: "Use a token for 192.168.1.20:8080" }));
  await userEvent.type(dialog.getByLabelText("Token for 192.168.1.20:8080"), "nas-key");
  await userEvent.click(dialog.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/connectors")).toEqual([
      { url: "http://192.168.1.20:8080/mcp", local: true, token: "nas-key" },
    ]),
  );
  const section = await connectors();
  expect(await section.findByText("Connected · On your own network")).toBeTruthy();
});

test("an app that registers no clients by itself asks for the person's client ID", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.connectors.needsClient.add("linear");
  });
  const tab = browserTab();
  const dialog = await openCatalogue();
  await userEvent.click(dialog.getByRole("button", { name: "Sign in for Linear" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("needs a client ID");
  expect(tab.close).toHaveBeenCalled();
  await userEvent.type(dialog.getByLabelText("Client ID for Linear"), "my-client");
  await userEvent.click(dialog.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/connectors").at(-1)).toEqual({
      catalogue: "linear",
      client_id: "my-client",
    }),
  );
});

test("an app whose sign-in ended reconnects from its row", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.connectors.connectors.push({
      id: "linear",
      name: "Linear",
      url: linear.url,
      sign_in: "oauth",
      state: "needs_reconnect",
      tools: 3,
    });
  });
  const tab = browserTab();
  const section = await connectors();
  expect(await section.findByText("Signed out")).toBeTruthy();
  await userEvent.click(section.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/connectors/linear/connect")).toHaveLength(1));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
});

/** Whether a switch is on, as assistive tech reads it. */
const checked = (element: HTMLElement) => element.getAttribute("aria-checked") === "true";

test("an app whose sign-in ends later shows it without a reload", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { spade } = await spadeApp("/settings/spade", (api) => {
      seed(api);
      api.connectors.connectors.push({
        id: "linear",
        name: "Linear",
        url: linear.url,
        sign_in: "oauth",
        state: "connected",
        tools: 3,
      });
    });
    const section = await connectors();
    expect(await section.findByText("Connected")).toBeTruthy();
    // Spade finds the sign-in expired while the page stays open.
    Object.assign(spade.connectors.connectors[0] ?? {}, { state: "needs_reconnect" });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await section.findByText("Signed out")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

/** Whether a switch can't be used now. */
const disabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

test("an app still signing in can't be given to a bot yet", async () => {
  await spadeApp("/spade/garden", (api) => {
    withApps(api);
    api.connectors.connectors.push({
      id: "sentry",
      name: "Sentry",
      url: "",
      sign_in: "oauth",
      state: "signing_in",
      tools: 0,
    });
  });
  await feed("Garden");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit bot" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Garden" }));
  expect(disabled(await dialog.findByRole("switch", { name: "Sentry" }))).toBe(true);
  expect(disabled(dialog.getByRole("switch", { name: "Linear" }))).toBe(false);
});

const feed = (name: string) => screen.findByRole("feed", { name: `Conversation with ${name}` });

function withApps(api: FakeSpadeApi) {
  seed(api);
  api.addAgent({ id: "garden", name: "Garden", model: "openrouter/meta/llama" });
  for (const [id, name] of [
    ["linear", "Linear"],
    ["notion", "Notion"],
  ])
    api.connectors.connectors.push({
      id,
      name,
      url: "",
      sign_in: "oauth",
      state: "connected",
      tools: 2,
    });
}

test("a bot's edit form turns on the apps it may use, and saves only that", async () => {
  const { spade } = await spadeApp("/spade/garden", withApps);
  await feed("Garden");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit bot" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Garden" }));
  const app = await dialog.findByRole("switch", { name: "Linear" });
  expect(checked(app)).toBe(false);
  expect(checked(dialog.getByRole("switch", { name: "Notion" }))).toBe(false);
  await userEvent.click(app);
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/garden/connectors")).toEqual([
      { all: false, connectors: ["linear"] },
    ]),
  );
  expect(spade.sent("PATCH", "/v1/agents/garden")).toEqual([]);
});

test("Spade may use every connected app until the person narrows it", async () => {
  const { spade } = await spadeApp("/spade/main", withApps);
  await feed("Spade");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit Spade" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Spade" }));
  const every = await dialog.findByRole("switch", { name: "Every connected app" });
  expect(checked(every)).toBe(true);
  expect(dialog.queryByRole("switch", { name: "Linear" })).toBeNull();
  await userEvent.click(every);
  // Narrowing starts from every app, so turning one off is the change.
  await userEvent.click(dialog.getByRole("switch", { name: "Notion" }));
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/main/connectors")).toEqual([
      { all: false, connectors: ["linear"] },
    ]),
  );
});
