import { longHistory, replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-replay-cursor";

/** The replay-cursor thread mid-turn, so messages follow up instead of starting a turn. */
async function openBusy(options: { followUp?: "steer" | "queue" } = {}) {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  if (options.followUp) {
    await app.client.start();
    await waitFor(() => expect(app.client.state).toBe("ready"));
    await app.client.request({
      type: "settings.set",
      key: "threads.followUpBehavior",
      value: options.followUp,
      layer: { kind: "global" },
    });
  }
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const message = await screen.findByRole("combobox", { name: "Message" });
  return { app, feed, message };
}

/** The daemon's queue, oldest first, as another device would read it. */
async function daemonQueue(app: ReturnType<typeof harness>) {
  const reply = await app.client.request({ type: "queue.get", threadId: ThreadId.parse(threadId) });
  return reply.queue.messages.map((message) =>
    message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  );
}

const pills = () =>
  within(screen.getByRole("list", { name: "Queued messages" }))
    .getAllByRole("listitem")
    .map((pill) => pill.textContent ?? "");

async function queueTwo(message: HTMLElement) {
  await userEvent.type(message, "Check the iOS path{Enter}");
  await userEvent.type(message, "Then the Android path{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(2));
}

async function pillMenu(text: string) {
  await userEvent.click(screen.getByRole("button", { name: `Queued message options: ${text}` }));
}

test("queued messages are the daemon's queue: reorder and remove change it there", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  expect(await daemonQueue(app)).toEqual(["Check the iOS path", "Then the Android path"]);

  await pillMenu("Then the Android path");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
  await waitFor(() => expect(pills()[0]).toContain("Then the Android path"));
  expect(await daemonQueue(app)).toEqual(["Then the Android path", "Check the iOS path"]);

  const first = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole(
    "listitem",
  )[0];
  if (!first) throw new Error("no pill");
  await userEvent.click(within(first).getByRole("button", { name: "Remove from queue" }));
  await waitFor(() => expect(pills()).toHaveLength(1));
  expect(await daemonQueue(app)).toEqual(["Check the iOS path"]);
});

test("editing a queued message rewrites it on the daemon before it is sent", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Cap retries at 3{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));
  await pillMenu("Cap retries at 3");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const field = await screen.findByRole("textbox", { name: "Edit queued message" });
  await userEvent.clear(field);
  await userEvent.type(field, "Cap retries at 5{Enter}");
  await waitFor(() => expect(pills()[0]).toContain("Cap retries at 5"));
  expect(await daemonQueue(app)).toEqual(["Cap retries at 5"]);
});

test("Send now steers a queued message into the running turn", async () => {
  const { app, feed, message } = await openBusy();
  await userEvent.type(message, "Use the cursor from the ack{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));
  await pillMenu("Use the cursor from the ack");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Send now" }));
  expect(await within(feed).findByText("Use the cursor from the ack")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(await daemonQueue(app)).toEqual([]);
});

test("with steering as the default, Enter steers and Ctrl+Enter queues instead", async () => {
  const { app, feed, message } = await openBusy({ followUp: "steer" });
  await userEvent.type(message, "Steer by default");
  // The send button says what Enter will do.
  expect(await screen.findByRole("button", { name: "Steer message" })).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(await within(feed).findByText("Steer by default")).toBeTruthy();
  await userEvent.type(message, "Wait for the turn{Control>}{Enter}{/Control}");
  await waitFor(() => expect(pills()[0]).toContain("Wait for the turn"));
  expect(within(feed).queryByText("Wait for the turn")).toBeNull();
  expect(await daemonQueue(app)).toEqual(["Wait for the turn"]);
});

test("a usage limit holds the queue, says when it resets and resumes on request", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  const reset = Date.now() + 2 * 60 * 60 * 1000;
  app.daemon.apply("thread-router", [
    { type: "turn.started", agent: "root", nativeTurnId: "limited", trigger: "user" },
    {
      type: "turn.ended",
      agent: "root",
      outcome: "failed",
      error: { kind: "quota", message: "5-hour limit reached" },
    },
    { type: "retry", agent: "root", on: "rate_limit", until: reset, message: "5-hour limit" },
  ]);
  await app.open("/t/thread-router");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const notice = await screen.findByRole("region", { name: "Usage limit reached" });
  expect(within(notice).getByText(/The account resets/)).toBeTruthy();

  // A message sent meanwhile waits on the daemon's queue.
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Then add a metric{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));

  await userEvent.click(within(notice).getByRole("button", { name: "Snooze until reset" }));
  const snoozed = await screen.findByRole("region", { name: "Snoozed until the limit resets" });
  expect(within(feed).queryByText("Then add a metric")).toBeNull();

  await userEvent.click(within(snoozed).getByRole("button", { name: "Resume now" }));
  expect(await within(feed).findByText("Then add a metric")).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: /Snoozed|Usage limit/ })).toBeNull(),
  );
});

test("a rate-limited thread shows the hold banner, not a working spinner", async () => {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.apply("thread-router", [
    { type: "turn.started", agent: "root", nativeTurnId: "limited", trigger: "user" },
    {
      type: "turn.ended",
      agent: "root",
      outcome: "failed",
      error: { kind: "quota", message: "5-hour limit reached" },
    },
    { type: "retry", agent: "root", on: "rate_limit", until: Date.now() + 3_600_000 },
  ]);
  await app.open("/t/thread-router");
  await screen.findByRole("region", { name: "Usage limit reached" });
  // The banner says it once; the transcript doesn't add "Rate limited" or a moving spinner.
  expect(screen.queryByText(/Rate limited/)).toBeNull();
  expect(document.querySelector('[role="status"] [data-slot="spinner"]')).toBeNull();
});

test("the composer shows how full the agent's context is", async () => {
  const { app } = await openBusy();
  expect(screen.queryByRole("meter", { name: "Context used" })).toBeNull();
  app.daemon.apply(threadId, [
    { type: "context.sample", agent: "root", usedTokens: 168_000, windowTokens: 200_000 },
  ]);
  const meter = await screen.findByRole("meter", { name: "Context used" });
  expect(meter.getAttribute("aria-valuenow")).toBe("84");
  expect(meter.getAttribute("aria-valuetext")).toBe("168,000 of 200,000 tokens in context");
});
