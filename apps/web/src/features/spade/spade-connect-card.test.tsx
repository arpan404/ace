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
  notes: "",
  category: "work",
  ready: "sign_in",
  key_url: "https://linear.app/settings/api",
};

/** A connect card from the bot Boards for Linear, asking with `way`. */
function asking(way: string, extra: Record<string, unknown> = {}) {
  return (api: FakeSpadeApi) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.connectors.catalogue.push(linear);
    const bot = api.addAgent({ id: "boards", name: "Boards" });
    api.card(bot, "q1", [
      {
        prompt: "To read your Linear board",
        kind: "connect",
        app: "linear",
        name: "Linear",
        way,
        can: ["Read and change what your Linear account can"],
        ...extra,
      },
    ]);
  };
}

function connected(api: FakeSpadeApi, state = "connected") {
  api.connectors.connectors.push({
    id: "linear",
    name: "Linear",
    url: linear.url,
    catalogue: "linear",
    sign_in: "oauth",
    state,
    account: "me@example.com",
    tools: 3,
  });
}

/** The browser tab a sign-in opens in, as `window.open` hands it back. */
function browserTab() {
  const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  return tab;
}

const card = async (name = "Boards asks to use Linear") =>
  within(
    await within(await screen.findByRole("feed", { name: "Conversation with Boards" })).findByRole(
      "group",
      { name },
    ),
  );

const feed = async () =>
  within(await screen.findByRole("feed", { name: "Conversation with Boards" }));

test("a bot asking for an unconnected app shows a connect card, and connecting continues the bot", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { spade } = await spadeApp("/spade/boards", asking("sign_in"));
    const tab = browserTab();
    const asked = await card();
    // The app, the bot's reason and what it may do, then one action in words.
    expect(asked.getByText("To read your Linear board")).toBeTruthy();
    expect(asked.getByText("Read and change what your Linear account can")).toBeTruthy();
    await userEvent.click(asked.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() =>
      expect(tab.location.replace).toHaveBeenCalledWith(
        "https://auth.example/authorize?client=linear",
      ),
    );
    expect(spade.sent("POST", "/v1/connectors")).toEqual([{ catalogue: "linear" }]);
    expect(
      await asked.findByText(
        "Finish signing in to Linear in your browser. This updates by itself.",
      ),
    ).toBeTruthy();
    spade.connectors.finishSignIn("linear", "me@example.com");
    await vi.advanceTimersByTimeAsync(2_000);
    // The app goes to the bot that asked, and the card settles to one quiet line.
    await waitFor(() =>
      expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toEqual([
        { connector: "linear", everyone: false },
      ]),
    );
    expect(await (await feed()).findByText("Connected as me@example.com")).toBeTruthy();
    expect(spade.connectors.access.get("boards")).toEqual({ all: false, connectors: ["linear"] });
  } finally {
    vi.useRealTimers();
  }
});

test("a sign-in an admin must approve says so, with what to do", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { spade } = await spadeApp("/spade/boards", asking("sign_in"));
    browserTab();
    const asked = await card();
    await userEvent.click(asked.getByRole("button", { name: "Connect Linear" }));
    await asked.findByText("Finish signing in to Linear in your browser. This updates by itself.");
    spade.connectors.failSignIn("linear", "needs_admin");
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await asked.findByRole("alert")).textContent).toBe(
      "Linear says your account needs admin approval. Ask your admin to allow Spade, then connect again.",
    );
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("Cancel stops following a sign-in, and Not now tells the bot to carry on", async () => {
  const { spade } = await spadeApp("/spade/boards", asking("sign_in"));
  browserTab();
  const asked = await card();
  await userEvent.click(asked.getByRole("button", { name: "Connect Linear" }));
  await userEvent.click(await asked.findByRole("button", { name: "Cancel" }));
  expect(asked.getByRole("button", { name: "Connect Linear" })).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Not now" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1")).toEqual([
      { dismiss: true },
    ]),
  );
  expect(await (await feed()).findByText("Not connected · Linear")).toBeTruthy();
});

test("Later folds the card to one line, and Connect opens it again", async () => {
  const { spade } = await spadeApp("/spade/boards", asking("sign_in"));
  await userEvent.click((await card()).getByRole("button", { name: "Later" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1")).toEqual([
      { defer: true },
    ]),
  );
  await waitFor(async () =>
    expect((await card()).getByText("For later · Connect Linear")).toBeTruthy(),
  );
  const folded = await card();
  await userEvent.click(folded.getByRole("button", { name: "Connect" }));
  expect((await card()).getByRole("button", { name: "Connect Linear" })).toBeTruthy();
});

test("an app connected for other bots is given with Use, without signing in again", async () => {
  const { spade } = await spadeApp("/spade/boards", (api) => {
    asking("use", { connector: "linear" })(api);
    connected(api);
  });
  await userEvent.click((await card()).getByRole("button", { name: "Use Linear" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toEqual([
      { connector: "linear", everyone: false },
    ]),
  );
  expect(spade.sent("POST", "/v1/connectors")).toEqual([]);
});

test("Let every bot use it gives the app to every bot", async () => {
  const { spade } = await spadeApp("/spade/boards", (api) => {
    asking("use", { connector: "linear" })(api);
    connected(api);
  });
  const asked = await card();
  await userEvent.click(asked.getByRole("checkbox", { name: "Let every bot use Linear" }));
  await userEvent.click(asked.getByRole("button", { name: "Use Linear" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toEqual([
      { connector: "linear", everyone: true },
    ]),
  );
});

test("an expired sign-in shows Reconnect, which signs in to the same app again", async () => {
  const { spade } = await spadeApp("/spade/boards", (api) => {
    asking("reconnect", { connector: "linear", retry: true })(api);
    connected(api, "needs_reconnect");
  });
  const tab = browserTab();
  const asked = await card("Boards asks to reconnect Linear");
  expect(asked.getByText("Its sign-in ended, so Boards can't use it now")).toBeTruthy();
  await userEvent.click(asked.getByRole("button", { name: "Reconnect Linear" }));
  await waitFor(() => expect(spade.sent("POST", "/v1/connectors/linear/connect")).toHaveLength(1));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
});

test("a key app shows its steps in the card and sends the key to Spade once", async () => {
  const { spade } = await spadeApp("/spade/boards", asking("key", { key_url: linear.key_url }));
  vi.spyOn(window, "open").mockReturnValue(null);
  const asked = await card();
  expect(asked.getByRole("button", { name: "Make a key in Linear" })).toBeTruthy();
  await userEvent.type(asked.getByLabelText(/Paste it here/), "lin_api_123");
  await userEvent.click(asked.getByRole("button", { name: "Add a key" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/connectors")).toEqual([
      { catalogue: "linear", token: "lin_api_123" },
    ]),
  );
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toHaveLength(1),
  );
});

test("a Coming soon app's card says it isn't available yet and offers nothing to connect", async () => {
  await spadeApp("/spade/boards", asking("later"));
  const asked = await card();
  expect(asked.getByText("Not available yet")).toBeTruthy();
  expect(asked.queryByRole("button", { name: /^Connect/ })).toBeNull();
  expect(asked.queryByRole("button", { name: "Add a key" })).toBeNull();
});

test("a bot's apps suggest the ones that fit its task, each a click from connected", async () => {
  const { spade } = await spadeApp("/spade/boards?profile=details", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.connectors.catalogue.push(linear, {
      id: "notion",
      name: "Notion",
      url: "https://mcp.notion.com/mcp",
      sign_in: ["oauth"],
      category: "work",
      ready: "sign_in",
    });
    api.connectors.fits = ["linear", "notion"];
    api.connectors.connectors.push({
      id: "notion",
      name: "Notion",
      url: "",
      catalogue: "notion",
      sign_in: "oauth",
      state: "connected",
      tools: 2,
    });
    api.addAgent({ id: "boards", name: "Boards", task: "Triage the issues on our board" });
  });
  const suggested = within(await screen.findByRole("region", { name: "Apps that fit" }));
  // Connected already for other bots: one click, no sign-in.
  await userEvent.click(await suggested.findByRole("button", { name: "Use Notion" }));
  await waitFor(() =>
    expect(spade.sent("PUT", "/v1/agents/boards/connectors")).toEqual([
      { all: false, connectors: ["notion"] },
    ]),
  );
  expect(spade.sent("POST", "/v1/connectors")).toEqual([]);
  // Not connected yet: Connect opens its sign-in.
  browserTab();
  await userEvent.click(await suggested.findByRole("button", { name: "Connect Linear" }));
  await waitFor(() =>
    expect(spade.sent("POST", "/v1/connectors")).toEqual([{ catalogue: "linear" }]),
  );
});

test("a browser that blocks the sign-in's tab gets it as a link, and the card still follows it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { spade } = await spadeApp("/spade/boards", asking("sign_in"));
    vi.spyOn(window, "open").mockReturnValue(null);
    const asked = await card();
    await userEvent.click(asked.getByRole("button", { name: "Connect Linear" }));
    const link = await asked.findByRole("link", { name: "Open Linear's sign-in" });
    expect(link.getAttribute("href")).toBe("https://auth.example/authorize?client=linear");
    expect(asked.queryByRole("alert")).toBeNull();
    spade.connectors.finishSignIn("linear", "me@example.com");
    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() =>
      expect(spade.sent("POST", "/v1/conversations/c-boards/questions/q1/connected")).toHaveLength(
        1,
      ),
    );
  } finally {
    vi.useRealTimers();
  }
});
