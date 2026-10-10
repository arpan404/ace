import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { CatalogEntry, ClientMessage, ServerMessage } from "@ace/protocol";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const tdd = CatalogEntry.parse({
  id: "claude-tdd",
  name: "tdd",
  title: "Test Driven Development",
  kind: "skill",
  description: "Write the failing test first.",
  source: { provider: "claude", scope: "global" },
  invocation: { type: "skill", name: "tdd", path: "/fixture/tdd/SKILL.md" },
});
function cold() {
  const app = harness({ throughWorker: true });
  app.daemon.createThread({
    id: "cold",
    workspaceId: "project",
    provider: "claude",
    title: "Cold start",
  });
  app.daemon.seedServices({
    settings: { "providers.default": "claude" },
    extensionCatalogs: { claude: [], pi: [] },
    catalogLoading: ["claude"],
  });
  return app;
}

/** Delay only the composer's first socket request; observe its real discovery reply. */
function discoveryReply(app: ReturnType<typeof cold>) {
  const released = Promise.withResolvers<void>();
  const replied = Promise.withResolvers<void>();
  const connect = app.daemon.connect.bind(app.daemon);
  app.daemon.connect = (wire) => {
    let requestId: string | undefined;
    const connection = connect({
      ...wire,
      send(text) {
        const message = ServerMessage.parse(JSON.parse(text));
        if (message.type === "catalog.list.result" && message.requestId === requestId)
          replied.resolve();
        wire.send(text);
      },
    });
    const receive = connection.receive.bind(connection);
    connection.receive = (text) => {
      const message = ClientMessage.parse(JSON.parse(text));
      if (
        message.type === "catalog.list" &&
        message.threadId === "cold" &&
        message.subscribe &&
        requestId === undefined
      ) {
        requestId = message.requestId;
        void released.promise.then(() => receive(text));
      } else receive(text);
    };
    return connection;
  };
  return { release: () => released.resolve(), replied: replied.promise };
}

test("Skills stays loading until discovery arrives in the open tab and opens the discovered skill", async () => {
  const app = cold();
  await app.open("/skills");
  expect(await screen.findAllByRole("status", { name: /Loading skills/ })).not.toHaveLength(0);
  expect(screen.queryByText("No skills yet")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  await userEvent.click(await screen.findByRole("link", { name: /^Test Driven Development/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Test Driven Development" }),
  ).toBeTruthy();
});

test("a cold slash menu reports loading and finds tdd when discovery completes without retyping", async () => {
  const app = cold();
  await app.open("/t/cold");
  const input = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(input, "/tdd");
  expect(await screen.findByText("Loading suggestions…")).toBeTruthy();
  expect(screen.queryByText("No matching suggestions")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  expect(await screen.findByRole("option", { name: /^Test Driven Development / })).toBeTruthy();
});

test("a cold slash query reports no matches only after discovery completes", async () => {
  const app = cold();
  await app.open("/t/cold");
  const input = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(input, "/missing-skill");
  expect(await screen.findByText("Loading suggestions…")).toBeTruthy();
  expect(screen.queryByText("No matching suggestions")).toBeNull();
  act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
  expect(await screen.findByText("No matching suggestions")).toBeTruthy();
  expect(screen.queryByText("Loading suggestions…")).toBeNull();
});

test("switching the Skills provider closes a detail from the previous provider", async () => {
  const app = cold();
  app.daemon.seedServices({ extensionCatalogs: { claude: [tdd], pi: [] } });
  await app.open("/skills");
  await userEvent.click(await screen.findByRole("link", { name: /^Test Driven Development/ }));
  await screen.findByRole("heading", { level: 1, name: "Test Driven Development" });
  await userEvent.click(screen.getByRole("combobox", { name: "Skills provider" }));
  await userEvent.click(await screen.findByRole("option", { name: /^Pi$/ }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Test Driven Development" })).toBeNull(),
  );
  await waitFor(() => expect(screen.queryByText("This isn't installed")).toBeNull());
});

test("the composer discovers skills before the first slash so a warm tdd menu needs no new request", async () => {
  const app = cold();
  const discovery = discoveryReply(app);
  app.daemon.seedServices({ extensionCatalogs: { claude: [] } });
  try {
    await app.open("/t/cold");
    const input = await screen.findByRole("combobox", { name: "Message" });
    // A visible editor does not mean its worker's discovery request has reached the daemon.
    // Warm only through the composer's existing subscription before blocking later reads.
    await act(async () => {
      discovery.release();
      await discovery.replied;
    });
    act(() => app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } }));
    app.daemon.holdRequests("catalog.list");
    await userEvent.type(input, "/tdd");
    expect(await screen.findByRole("option", { name: /^Test Driven Development / })).toBeTruthy();
  } finally {
    discovery.release();
  }
});

test("Skills discovers fallback-provider entries while provider readiness never answers", async () => {
  const app = cold();
  app.daemon.holdRequests("providers.request", "models.list");
  app.daemon.seedServices({
    extensionCatalogs: {
      claude: [],
      codex: [{ ...tdd, id: "codex-tdd", source: { provider: "codex", scope: "global" } }],
    },
  });
  await app.open("/skills");
  expect(await screen.findByRole("link", { name: /^Test Driven Development/ })).toBeTruthy();
});

test("a failed slash catalog offers Retry and restores suggestions without closing the menu", async () => {
  const app = cold();
  app.daemon.seedServices({ extensionCatalogs: { claude: [tdd] } });
  app.daemon.failRequests("catalog.list");
  await app.open("/t/cold");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "/tdd");
  await screen.findByText("Couldn't load suggestions.");
  app.daemon.restoreRequests();
  await userEvent.click(screen.getByRole("button", { name: "Retry suggestions" }));
  expect(await screen.findByRole("option", { name: /^Test Driven Development / })).toBeTruthy();
});

test("native skills appear while the portable plugin read is still pending", async () => {
  const app = cold();
  app.daemon.holdRequests("pluginRequest", "providers.request");
  app.daemon.seedServices({ extensionCatalogs: { codex: [tdd] } });
  await app.open("/skills");
  expect(await screen.findByRole("link", { name: /^Test Driven Development/ })).toBeTruthy();
  expect(screen.queryByText("No skills yet")).toBeNull();
});
