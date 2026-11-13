import type { FakeDaemon, FakeSpadeApi } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** The hidden ace thread Scout's browser and screen run in. */
const thread = "bot-scout";

function seed(spade: FakeSpadeApi) {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
  spade.addAgent({ id: "scout", name: "Scout" });
}

/**
 * Scout's browser in its thread: its own tab on the hotel site, and a tab the person opened
 * after it, which the thread shows.
 */
function browsing(daemon: FakeDaemon) {
  // The bot's own thread, which Spade's threads are: hidden from every list.
  daemon.createThread({
    id: thread,
    workspaceId: "acme",
    title: "Scout's computer",
    provider: "codex",
    host: "spade-bot",
  });
  daemon.browser.drive(thread, { url: "https://www.staybook.com/lisbon" });
  const botTab = daemon.browser.view(thread)?.activeTabId ?? "";
  daemon.browser.personOpen(thread, "https://example.com/");
  return botTab;
}

/** Scout's TextEdit session, started for its thread. */
async function onScreen(daemon: FakeDaemon) {
  const channel = daemon.screen.connection(() => {});
  let id = 0;
  const call = (operation: Record<string, unknown>) =>
    channel.request({ type: "screen.request", requestId: `seed-${++id}`, operation } as never);
  await call({ op: "enable", enabled: true });
  await call({
    op: "start",
    target: { kind: "app", bundleId: "com.apple.TextEdit" },
    threadId: thread,
    fps: 10,
  });
}

test("the person types in the bot's browser without taking over, into the bot's own tab", async () => {
  let botTab = "";
  const { app, spade } = await spadeApp("/spade/scout?computer=browser", seed, {
    daemon: (daemon) => {
      botTab = browsing(daemon);
    },
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", {
    kind: "browser",
    live: true,
    title: "Hotels",
    url: "https://www.staybook.com/lisbon",
    tab_id: botTab,
  });
  // The thread shows the bot's tab, not the one the person opened there.
  await waitFor(() => expect(app.daemon.browser.view(thread)?.activeTabId).toBe(botTab));
  const panel = await screen.findByRole("tabpanel", { name: "Browser" });
  const page = await within(panel).findByRole("application", { name: /^Control / });
  fireEvent.keyDown(page, { key: "a", code: "KeyA" });
  await waitFor(() =>
    expect(app.daemon.browser.inputs.some((each) => each.threadId === thread)).toBe(true),
  );
  expect(
    app.daemon.browser.inputs.filter((each) => each.threadId === thread).map((each) => each.tabId),
  ).toEqual(expect.arrayContaining([botTab]));
  // Still shared: Spade never heard of a take-over.
  expect(spade.computer.driver("scout")).toBe("bot");
  expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
});

test("a tab in the person's own Chrome isn't streamed: it offers to open there", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { spade } = await spadeApp("/spade/scout?computer=browser", seed);
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", {
    kind: "browser",
    live: true,
    title: "Mail",
    url: "https://mail.example.com/inbox",
    tab_id: "chrome-7",
    backend: "user",
  });
  await screen.findByText("Scout is using a tab in your own Chrome.");
  await userEvent.click(screen.getByRole("button", { name: "Open in Chrome" }));
  expect(open).toHaveBeenCalledWith(
    "https://mail.example.com/inbox",
    "_blank",
    "noopener,noreferrer",
  );
});

test("the person's input reaches the bot's screen without taking over or taking its controls", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=screen", seed, {
    daemon: (daemon) => void onScreen(daemon),
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", { kind: "screen", live: true, title: "TextEdit" });
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBe("0"),
  );
  fireEvent.keyDown(screen.getByRole("img", { name: "Scout's screen" }), { key: "a" });
  await waitFor(() =>
    expect(app.daemon.screen.inputs.map((each) => each.input)).toEqual([
      { kind: "text.type", text: "a" },
    ]),
  );
  // Shared: nobody claimed the session's controls for the person.
  expect((await sessions(app.daemon)).map((each) => each.controller)).not.toContain("human");
});

test("while Take over is on its way, the bot's screen takes no input until the controls are the person's", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=screen", seed, {
    daemon: (daemon) => void onScreen(daemon),
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", { kind: "screen", live: true, title: "TextEdit" });
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBe("0"),
  );
  // Exclusive mode, with the bot's work still stopping: the view only shows.
  spade.computer.stopping("scout", true);
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await screen.findByText("Stopping Scout…");
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBeNull(),
  );
  fireEvent.keyDown(screen.getByRole("img", { name: "Scout's screen" }), { key: "a" });
  expect(app.daemon.screen.inputs).toHaveLength(0);
  spade.computer.stopping("scout", false);
  await waitFor(async () =>
    expect((await sessions(app.daemon)).map((each) => each.controller)).toEqual(["human"]),
  );
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBe("0"),
  );
});

/** The screen sessions as the daemon holds them now, read on a channel of the test's own. */
async function sessions(daemon: FakeDaemon) {
  let answer: unknown;
  const channel = daemon.screen.connection((message) => {
    if (!(message instanceof Uint8Array) && message.type === "screen.result" && message.ok)
      answer = message.data;
  });
  await channel.request({
    type: "screen.request",
    requestId: "read-sessions",
    operation: { op: "sessions" },
  } as never);
  channel.close();
  return answer as { sessionId: string; controller: string }[];
}

test("the screen's controls go back once its view goes, so nothing stays the person's", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=screen", seed, {
    daemon: (daemon) => void onScreen(daemon),
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", { kind: "screen", live: true, title: "TextEdit" });
  await screen.findByRole("img", { name: "Scout's screen" });
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await waitFor(async () =>
    expect((await sessions(app.daemon)).map((each) => each.controller)).toEqual(["human"]),
  );
  // Off to the files while still driving: the screen's view goes, and its controls with it.
  await userEvent.click(screen.getByRole("tab", { name: "Files" }));
  await waitFor(async () =>
    expect((await sessions(app.daemon)).map((each) => each.controller)).toEqual(["none"]),
  );
});

test("a late answer to taking the screen never lets go of the controls taken again since", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=screen", seed, {
    daemon: (daemon) => void onScreen(daemon),
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", { kind: "screen", live: true, title: "TextEdit" });
  await screen.findByRole("img", { name: "Scout's screen" });
  // Taking the controls waits; meanwhile the person hands back and takes over again.
  const release = app.daemon.screen.holdControl();
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await screen.findByRole("button", { name: "Hand back" });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Hand back" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await screen.findByRole("button", { name: "Take over" });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Take over" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Hand back" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  release();
  await waitFor(async () =>
    expect((await sessions(app.daemon)).map((each) => each.controller)).toEqual(["human"]),
  );
  // Settled: no late "let go" follows.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await sessions(app.daemon)).map((each) => each.controller)).toEqual(["human"]);
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBe("0"),
  );
});

test("a bot that hasn't opened its browser yet says so", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=browser", seed);
  spade.computer.use("scout", { kind: "browser", live: true, title: null, url: null });
  await screen.findByText("Scout hasn't opened its browser yet.");
});
