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

test("the bot's browser shows its own tab from its ace thread, and takes the person's keys only while they drive", async () => {
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
  expect(within(panel).queryByRole("application")).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  const page = await within(panel).findByRole("application", { name: /^Control / });
  fireEvent.keyDown(page, { key: "a", code: "KeyA" });
  await waitFor(() =>
    expect(app.daemon.browser.inputs.some((each) => each.threadId === thread)).toBe(true),
  );
  expect(
    app.daemon.browser.inputs.filter((each) => each.threadId === thread).map((each) => each.tabId),
  ).toEqual(expect.arrayContaining([botTab]));

  await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
  await waitFor(() => expect(within(panel).queryByRole("application")).toBeNull());
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

test("the bot's screen shows the session its thread started, and the person's input reaches it only once they drive", async () => {
  const { app, spade } = await spadeApp("/spade/scout?computer=screen", seed, {
    daemon: (daemon) => void onScreen(daemon),
  });
  spade.computer.thread("scout", thread);
  spade.computer.use("scout", { kind: "screen", live: true, title: "TextEdit" });
  const view = await screen.findByRole("img", { name: "Scout's screen" });
  fireEvent.keyDown(view, { key: "a" });
  expect(app.daemon.screen.inputs).toHaveLength(0);

  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Scout's screen" }).getAttribute("tabindex")).toBe("0"),
  );
  fireEvent.keyDown(screen.getByRole("img", { name: "Scout's screen" }), { key: "a" });
  await waitFor(() =>
    expect(app.daemon.screen.inputs.map((each) => each.input)).toEqual([
      { kind: "text.type", text: "a" },
    ]),
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

test("a bot that hasn't opened its browser yet says so", async () => {
  const { spade } = await spadeApp("/spade/scout?computer=browser", seed);
  spade.computer.use("scout", { kind: "browser", live: true, title: null, url: null });
  await screen.findByText("Scout hasn't opened its browser yet.");
});
