import { longHistory, replayCursor } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

test("queued bubbles offer only sending and taking back, preserving daemon order", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  expect(await daemonQueue(app)).toEqual(["Check the iOS path", "Then the Android path"]);
  const queued = screen.getByRole("list", { name: "Queued messages" });
  const rows = within(queued).getAllByRole("listitem");
  for (const row of rows) {
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Send now", "Take back to composer"]);
  }
  const first = rows[0];
  if (!first) throw new Error("no queued message");
  await userEvent.click(within(first).getByRole("button", { name: "Take back to composer" }));
  await waitFor(() => expect(pills()).toHaveLength(1));
  expect(await daemonQueue(app)).toEqual(["Then the Android path"]);
  expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Check the iOS path");
});

test("a queued message can be taken back, edited and queued again", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Cap retries at 3{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.click(within(queued).getByRole("button", { name: "Take back to composer" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  const restored = screen.getByRole("combobox", { name: "Message" });
  expect(restored.textContent).toBe("Cap retries at 3");
  await userEvent.clear(restored);
  await userEvent.type(restored, "Cap retries at 5{Enter}");
  await waitFor(() => expect(pills()[0]).toContain("Cap retries at 5"));
  expect(await daemonQueue(app)).toEqual(["Cap retries at 5"]);
});

test("Send now steers a queued message into the running turn", async () => {
  const { app, feed, message } = await openBusy();
  await userEvent.type(message, "Use the cursor from the ack{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));
  await userEvent.click(
    within(screen.getByRole("list", { name: "Queued messages" })).getByRole("button", {
      name: "Send now",
    }),
  );
  expect(await within(feed).findByText("Use the cursor from the ack")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(await daemonQueue(app)).toEqual([]);
});

test("taking back a queued message appends its text to the current draft once", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Check the retry path{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.type(message, "Keep this draft");
  const takeBack = within(queued).getByRole("button", { name: "Take back to composer" });
  fireEvent.click(takeBack);
  fireEvent.click(takeBack);
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Keep this draft\n\nCheck the retry path",
  );
  expect(await daemonQueue(app)).toEqual([]);
});

test("taking back a queued attachment restores it alongside the current draft", async () => {
  const { app, message } = await openBusy();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["hello"], "trace.txt", { type: "text/plain" }),
  );
  await userEvent.type(message, "Review this trace{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  const takeBack = await within(queued).findByRole("button", { name: "Take back to composer" });
  const reply = await app.client.request({ type: "queue.get", threadId: ThreadId.parse(threadId) });
  const sha256 = reply.queue.messages[0]?.context?.attachments[0]?.sha256;
  expect(sha256).toBeTruthy();
  await userEvent.type(message, "Keep this draft");
  await userEvent.click(takeBack);
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Keep this draft\n\nReview this trace",
  );
  expect(
    within(await screen.findByRole("list", { name: "Attachments" })).getByText("trace.txt"),
  ).toBeTruthy();
  expect(app.storage.getItem("ace.composer.drafts")).toContain(sha256);
});

test("a refused take back keeps the queued message and leaves the current draft intact", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Check retries{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.type(message, "Keep this draft");
  app.daemon.refuseCommands("queue_conflict", "queue.remove");
  await userEvent.click(within(queued).getByRole("button", { name: "Take back to composer" }));
  await screen.findByText("Couldn't take back the message");
  expect(
    within(screen.getByRole("list", { name: "Queued messages" })).getByText("Check retries"),
  ).toBeTruthy();
  expect(message.textContent).toBe("Keep this draft");
  expect(await daemonQueue(app)).toEqual(["Check retries"]);
});

test("a refused Send now keeps the pending bubble without adding a confirmed message", async () => {
  const { app, feed, message } = await openBusy();
  await userEvent.type(message, "Check retries{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  app.daemon.refuseCommands("queue_conflict", "queue.edit");
  await userEvent.dblClick(within(queued).getByRole("button", { name: "Send now" }));
  await screen.findByText("Couldn't send it now");
  expect(
    within(screen.getByRole("list", { name: "Queued messages" })).getByText("Check retries"),
  ).toBeTruthy();
  expect(within(feed).queryByText("Check retries")).toBeNull();
  expect(await daemonQueue(app)).toEqual(["Check retries"]);
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

  await userEvent.click(within(notice).getByRole("button", { name: "Limit actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Snooze until reset" }));
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

test("a queued ask appears after the previous reply when its execution turn starts", async () => {
  const { facts } = await import("@ace/fake-daemon");
  const { act } = await import("@testing-library/react");
  const app = harness();
  app
    .play({
      thread: { id: "qa-order", workspaceId: "ace", title: "Queue order", provider: "codex" },
      steps: [
        {
          kind: "facts",
          label: "busy",
          facts: [
            facts.rootAgent("codex"),
            facts.turn("root"),
            facts.message("root", "ask", "user", "Run sleep then reply QA_HOLD_DONE"),
          ],
        },
      ],
    })
    .runThrough("busy");
  await app.open("/t/qa-order");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await app.client.command({
    type: "thread.send",
    threadId: ThreadId.parse("qa-order"),
    input: [{ type: "text", text: "Reply QA_QUEUED" }],
    delivery: "queue",
  });
  await screen.findByRole("list", { name: "Queued messages" });
  expect(within(feed).queryByText("Reply QA_QUEUED")).toBeNull();
  act(() =>
    app.daemon.apply("qa-order", [
      facts.message("root", "hold-answer", "assistant", "QA_HOLD_DONE"),
      facts.endTurn("root"),
    ]),
  );
  const queued = await within(feed).findByText("Reply QA_QUEUED");
  const answer = within(feed).getByText("QA_HOLD_DONE");
  expect(answer.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() =>
    app.daemon.apply("qa-order", [
      facts.message("root", "queued-answer", "assistant", "QA_QUEUED"),
      facts.endTurn("root"),
    ]),
  );
  const reply = await within(feed).findByText("QA_QUEUED");
  expect(queued.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
