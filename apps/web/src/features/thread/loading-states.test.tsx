import { longHistory, type FakeDaemon } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-router";
const latest = "Answer 6: route 6 renders its own panel.";

const isThreadSubscribe = (text: string) => {
  const message: unknown = JSON.parse(text);
  if (typeof message !== "object" || message === null) return false;
  const scope = "scope" in message ? message.scope : undefined;
  return (
    "type" in message &&
    message.type === "subscribe" &&
    typeof scope === "object" &&
    scope !== null &&
    "kind" in scope &&
    scope.kind === "thread"
  );
};

/**
 * A daemon slow to answer: while `held`, thread subscriptions reaching it go unanswered (the
 * request-level faults don't cover subscriptions). Set before the client connects.
 */
function holdThreadSubscriptions(daemon: FakeDaemon) {
  const state = { held: false };
  const connect = daemon.connect.bind(daemon);
  daemon.connect = (wire) => {
    const connection = connect(wire);
    const receive = connection.receive.bind(connection);
    connection.receive = (text: string) => {
      if (state.held && isThreadSubscribe(text)) return;
      receive(text);
    };
    return connection;
  };
  return state;
}

/** Every text that ever appeared on the page while watching, for "never flashed" checks. */
function watchFor(text: string) {
  let seen = false;
  const check = () => {
    if (document.body.textContent?.includes(text)) seen = true;
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  check();
  return {
    seen: () => seen,
    stop: () => observer.disconnect(),
  };
}

const watchers: { stop(): void }[] = [];
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop();
});

test("a thread that opens promptly never flashes a loading state", async () => {
  const app = harness();
  app.play(longHistory(6, threadId)).runUntilBlocked();
  const loading = watchFor("Loading messages");
  watchers.push(loading);
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(latest);
  // Past the moment a slow open would have said so.
  await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
  expect(loading.seen()).toBe(false);
});

test("a thread whose messages are slow to arrive says Loading messages… after a moment, then shows them", async () => {
  const app = harness();
  app.play(longHistory(6, threadId)).runUntilBlocked();
  const daemon = holdThreadSubscriptions(app.daemon);
  daemon.held = true;
  await app.open(`/t/${threadId}`);
  // Nothing at first: a quick open would be done by now.
  expect(screen.queryByText("Loading messages…")).toBeNull();
  const status = await screen.findByRole("status", { name: "Loading messages" });
  expect(within(status).getByText("Loading messages…")).toBeTruthy();
  expect(screen.queryByText("Syncing…")).toBeNull();

  // The daemon answers on the next connection: the messages replace the loading state.
  daemon.held = false;
  act(() => app.daemon.disconnectAll());
  const feed = await screen.findByRole("feed", { name: "Transcript" }, { timeout: 5_000 });
  await within(feed).findByText(latest);
  expect(screen.queryByRole("status", { name: "Loading messages" })).toBeNull();
});

test("after a reconnect, Syncing… shows beside the title while the thread catches up, over its messages", async () => {
  const app = harness({ throughWorker: true });
  const script = app.play(longHistory(6, threadId));
  script.runUntilBlocked();
  const daemon = holdThreadSubscriptions(app.daemon);
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(latest);
  const loading = watchFor("Loading messages");
  watchers.push(loading);

  // The connection comes back, but the replay of what changed meanwhile hasn't landed.
  daemon.held = true;
  act(() => app.daemon.disconnectAll());
  const syncing = await screen.findByText("Syncing…", {}, { timeout: 5_000 });
  expect(syncing.closest("header")).toBeTruthy();
  // What was on screen stays there while it catches up; nothing says it is loading.
  expect(within(feed).getByText(latest)).toBeTruthy();
  expect(loading.seen()).toBe(false);

  // Caught up: the note goes.
  daemon.held = false;
  act(() => app.daemon.disconnectAll());
  await waitFor(() => expect(screen.queryByText("Syncing…")).toBeNull(), { timeout: 5_000 });
  expect(within(feed).getByText(latest)).toBeTruthy();
});

test("a reconnect that catches up promptly never flashes Syncing…", async () => {
  const app = harness({ throughWorker: true });
  app.play(longHistory(6, threadId)).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(latest);
  const syncing = watchFor("Syncing…");
  watchers.push(syncing);
  act(() => app.daemon.disconnectAll());
  // Back and caught up, with time to spare past the delay.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
  expect(app.client.state).toBe("ready");
  expect(syncing.seen()).toBe(false);
});

test("while the connection is still coming back, Syncing… stays hidden: the connection notice speaks", async () => {
  const app = harness({ throughWorker: true });
  app.play(longHistory(6, threadId)).runUntilBlocked();
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(latest);
  const syncing = watchFor("Syncing…");
  watchers.push(syncing);
  // The daemon refuses every connection: the thread is behind, but nothing is catching it up.
  act(() => app.daemon.refuseConnections(true));
  await act(() => new Promise((resolve) => setTimeout(resolve, 1_200)));
  expect(app.client.state).not.toBe("ready");
  expect(syncing.seen()).toBe(false);
  expect(within(feed).getByText(latest)).toBeTruthy();
  act(() => app.daemon.refuseConnections(false));
});
