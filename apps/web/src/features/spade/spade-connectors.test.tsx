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

test("Spade may use every connected app, each its own switch, until the person turns one off", async () => {
  const { spade } = await spadeApp("/spade/main", withApps);
  await feed("Spade");
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit Spade" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Edit Spade" }));
  // Every app is on, each shown by name.
  expect(checked(await dialog.findByRole("switch", { name: "Linear" }))).toBe(true);
  expect(checked(dialog.getByRole("switch", { name: "Notion" }))).toBe(true);
  // Turning one off narrows Spade to the rest.
  await userEvent.click(dialog.getByRole("switch", { name: "Notion" }));
  await userEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/main/connectors")).toEqual([
      { all: false, connectors: ["linear"] },
    ]),
  );
});

/** GitHub as Spade lists it once its own app's client ID ships: Sign in leads. */
const github = {
  id: "github",
  name: "GitHub",
  url: "https://api.githubcopilot.com/mcp/",
  sign_in: ["oauth", "token", "oauth_client"],
  notes: "",
};

function withGitHub(api: FakeSpadeApi) {
  seed(api);
  api.connectors.catalogue.push(github);
  api.connectors.deviceSignIn.add("github");
}

/** Runs `body` on fake timers, so the two-second follow of a sign-in passes at once. */
async function onFakeTimers(body: (user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    await body(userEvent.setup({ advanceTimers: vi.advanceTimersByTime }));
  } finally {
    vi.useRealTimers();
  }
}

/** Lets the connectors list read Spade again, as it does every two seconds during a sign-in. */
const followed = () => vi.advanceTimersByTimeAsync(2_100);

test("a device sign-in shows its code in the app's row, with Copy code and Open, until it connects", () =>
  onFakeTimers(async (user) => {
    const { spade } = await spadeApp("/settings/spade", withGitHub);
    const tab = browserTab();
    const dialog = await openCatalogue();
    await user.click(dialog.getByRole("button", { name: "Sign in for GitHub" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Nothing to open in the browser: the code comes first.
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(spade.sent("POST", "/v1/connectors")).toEqual([{ catalogue: "github" }]);
    const section = await connectors();
    expect(
      await section.findByText("Enter WDJB-MJH1 on GitHub's page to finish signing in."),
    ).toBeTruthy();
    await user.click(section.getByRole("button", { name: "Copy code" }));
    expect(await section.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe("WDJB-MJH1");
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    await user.click(section.getByRole("button", { name: "Open" }));
    expect(opened).toHaveBeenCalledWith(
      "https://github.com/login/device",
      "_blank",
      "noopener,noreferrer",
    );
    spade.connectors.finishSignIn("github", "octo@example.com");
    await followed();
    expect(await section.findByText("Connected as octo@example.com")).toBeTruthy();
    expect(section.queryByRole("button", { name: "Copy code" })).toBeNull();
  }));

test("a device code that expired or was declined says so, and Try again shows a new code", () =>
  onFakeTimers(async (user) => {
    const { spade } = await spadeApp("/settings/spade", withGitHub);
    browserTab();
    const dialog = await openCatalogue();
    await user.click(dialog.getByRole("button", { name: "Sign in for GitHub" }));
    const section = await connectors();
    expect(await section.findByText(/^Enter WDJB-MJH1 /)).toBeTruthy();

    spade.connectors.endDeviceSignIn("github", "expired");
    await followed();
    expect(await section.findByText("The code expired before it was entered.")).toBeTruthy();
    expect(section.queryByRole("button", { name: "Copy code" })).toBeNull();
    await user.click(section.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(spade.sent("POST", "/v1/connectors/github/connect")).toHaveLength(1),
    );
    expect(await section.findByText(/^Enter WDJB-MJH2 /)).toBeTruthy();

    spade.connectors.endDeviceSignIn("github", "denied");
    await followed();
    expect(await section.findByText("The sign-in was declined on GitHub.")).toBeTruthy();
    expect(section.getByRole("button", { name: "Try again" })).toBeTruthy();
  }));

const asana = {
  id: "asana",
  name: "Asana",
  url: "https://mcp.asana.com/v2/mcp",
  sign_in: ["oauth", "oauth_client"],
  via: "cloud",
  notes: "Signs in through Spade Cloud with your ace account.",
};

test("an app through Spade Cloud signs in in the browser and its row says it signs in through the cloud", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.connectors.catalogue.push(asana);
    api.connectors.viaCloud.add("asana");
  });
  const tab = browserTab();
  const dialog = await openCatalogue();
  await userEvent.click(dialog.getByRole("button", { name: "Sign in for Asana" }));
  await waitFor(() =>
    expect(tab.location.replace).toHaveBeenCalledWith(
      "https://auth.example/authorize?client=asana",
    ),
  );
  spade.connectors.finishSignIn("asana", "me@example.com");
  const section = await connectors();
  expect(
    await section.findByText("Connected as me@example.com · Signs in through Spade Cloud"),
  ).toBeTruthy();
});

test("signed out of ace, an app through Spade Cloud says to sign in to ace instead of asking for a client ID", async () => {
  const { spade } = await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.connectors.catalogue.push(asana);
    api.connectors.viaCloud.add("asana");
    api.connectors.aceSignedOut = true;
  });
  const tab = browserTab();
  const dialog = await openCatalogue();
  await userEvent.click(dialog.getByRole("button", { name: "Sign in for Asana" }));
  const alert = await dialog.findByRole("alert");
  expect(alert.textContent).toContain(
    "Sign in to your ace account on this machine to connect Asana through Spade Cloud.",
  );
  expect(tab.close).toHaveBeenCalled();
  expect(dialog.queryByLabelText("Client ID for Asana")).toBeNull();
  expect(spade.sent("POST", "/v1/connectors")).toEqual([{ catalogue: "asana" }]);
  await userEvent.click(within(alert).getByRole("button", { name: "Sign in to ace" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an app through Spade Cloud that can't renew while signed out of ace says so, with Sign in to ace", async () => {
  await spadeApp("/settings/spade", (api) => {
    seed(api);
    api.connectors.connectors.push({
      id: "asana",
      name: "Asana",
      url: asana.url,
      catalogue: "asana",
      sign_in: "oauth",
      state: "connected",
      tools: 3,
      via: "cloud",
      notice: "ace_signed_out",
    });
  });
  const section = await connectors();
  expect(
    await section.findByText(
      "Connected · Sign in to ace to keep it signed in through Spade Cloud.",
    ),
  ).toBeTruthy();
  await userEvent.click(section.getByRole("button", { name: "Sign in to ace" }));
  expect(await screen.findByRole("heading", { name: "Profile" })).toBeTruthy();
});
