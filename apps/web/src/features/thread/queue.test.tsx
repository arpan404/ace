import { longHistory, replayCursor } from "@ace/fake-daemon";
import { CommandId, ThreadId } from "@ace/protocol";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openEffortControl, chooseEffort, closeModelControl } from "@/test/model-control.ts";

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
  const reply = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
    limit: 32,
  });
  return reply.queue.messages.map((message) =>
    message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  );
}

const pills = () =>
  within(screen.getByRole("list", { name: "Queued messages" }))
    .getAllByRole("listitem")
    .map((pill) => pill.textContent ?? "");

async function queuedEditButton(queued = screen.getByRole("list", { name: "Queued messages" })) {
  const edit = within(queued).getByRole("button", { name: "Edit queued message" });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  return edit;
}

async function takeBackButton(queued: HTMLElement) {
  await userEvent.click(await queuedEditButton(queued));
  return screen.findByRole("button", { name: "Take back to composer" });
}

async function queueTwo(message: HTMLElement) {
  await userEvent.type(message, "Check the iOS path{Enter}");
  await userEvent.type(message, "Then the Android path{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(2));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Reorder queued message 2" })
        .getAttribute("aria-disabled"),
    ).toBe("false"),
  );
}

test("removing a queued message preserves the next message and the current draft", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  expect(await daemonQueue(app)).toEqual(["Check the iOS path", "Then the Android path"]);
  await userEvent.type(message, "Keep this draft");
  const first = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole(
    "listitem",
  )[0];
  if (!first) throw new Error("no queued message");
  await userEvent.click(within(first).getByRole("button", { name: "Remove queued message" }));
  await waitFor(() => expect(pills()).toHaveLength(1));
  expect(await daemonQueue(app)).toEqual(["Then the Android path"]);
  expect(message.textContent).toBe("Keep this draft");
});

test("a queued message can be taken back, edited and queued again", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Cap retries at 3{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.click(await takeBackButton(queued));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  const restored = screen.getByRole("combobox", { name: "Message" });
  expect(restored.textContent).toBe("Cap retries at 3");
  await userEvent.clear(restored);
  await userEvent.type(restored, "Cap retries at 5{Enter}");
  await waitFor(() => expect(pills()[0]).toContain("Cap retries at 5"));
  expect(await daemonQueue(app)).toEqual(["Cap retries at 5"]);
});

test("Steer sends a queued message into the running turn", async () => {
  const { app, feed, message } = await openBusy();
  await userEvent.type(message, "Use the cursor from the ack{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));
  await userEvent.click(
    within(screen.getByRole("list", { name: "Queued messages" })).getByRole("button", {
      name: "Steer",
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
  const takeBack = await takeBackButton(queued);
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
  const reply = await app.client.request({ type: "queue.get", threadId: ThreadId.parse(threadId) });
  const sha256 = reply.queue.messages[0]?.context?.attachments[0]?.sha256;
  expect(sha256).toBeTruthy();
  await userEvent.type(message, "Keep this draft");
  const takeBack = await takeBackButton(queued);
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
  await userEvent.click(await takeBackButton(queued));
  await screen.findByRole("alertdialog", { name: "Couldn't take back the message" });
  expect(
    within(screen.getByRole("list", { name: "Queued messages" })).getByText("Check retries"),
  ).toBeTruthy();
  expect(message.textContent).toBe("Keep this draft");
  expect(await daemonQueue(app)).toEqual(["Check retries"]);
});

test("a refused Steer keeps the pending bubble without adding a confirmed message", async () => {
  const { app, feed, message } = await openBusy();
  await userEvent.type(message, "Check retries{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  app.daemon.refuseCommands("queue_conflict", "queue.edit");
  await userEvent.dblClick(within(queued).getByRole("button", { name: "Steer" }));
  await screen.findByRole("alertdialog", { name: "Couldn't send it now" });
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

test("keyboard reordering changes daemon order and keeps the handle focused", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  await waitFor(async () => expect(await daemonQueue(app)).toHaveLength(2));
  const handle = screen.getByRole("button", { name: "Reorder queued message 2" });
  handle.focus();
  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
  await waitFor(async () =>
    expect(await daemonQueue(app)).toEqual(["Then the Android path", "Check the iOS path"]),
  );
  expect(document.activeElement).toBe(handle);
  expect(pills()[0]).toContain("Then the Android path");
});

test("a refused reorder restores the daemon order", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  app.daemon.refuseCommands("queue_conflict", "queue.move");
  screen.getByRole("button", { name: "Reorder queued message 2" }).focus();
  await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
  await screen.findByRole("alertdialog", { name: "Couldn't move the message" });
  await waitFor(() => expect(pills()[0]).toContain("Check the iOS path"));
  expect(await daemonQueue(app)).toEqual(["Check the iOS path", "Then the Android path"]);
});

test("dragging moves a queued message to a nonadjacent position", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  await userEvent.type(message, "Finally check web{Enter}");
  await waitFor(async () => expect(await daemonQueue(app)).toHaveLength(3));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Reorder queued message 3" })
        .getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  const rows = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole(
    "listitem",
  );
  const target = rows[2];
  if (!target) throw new Error("no drop target");
  fireEvent.dragStart(screen.getByRole("button", { name: "Reorder queued message 1" }), {
    dataTransfer: { setData() {}, effectAllowed: "" },
  });
  fireEvent.drop(target);
  await waitFor(async () =>
    expect(await daemonQueue(app)).toEqual([
      "Then the Android path",
      "Finally check web",
      "Check the iOS path",
    ]),
  );
});

test("a queue change during a drag asks the user to move again", async () => {
  const { app, message } = await openBusy();
  await queueTwo(message);
  const rows = within(screen.getByRole("list", { name: "Queued messages" })).getAllByRole(
    "listitem",
  );
  const target = rows[1];
  if (!target) throw new Error("no drop target");
  fireEvent.dragStart(screen.getByRole("button", { name: "Reorder queued message 1" }), {
    dataTransfer: { setData() {}, effectAllowed: "" },
  });
  await userEvent.type(message, "A new message{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(3));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Reorder queued message 3" })
        .getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  fireEvent.drop(target);
  await screen.findByText("The queue changed. Try moving the message again.");
  expect(await daemonQueue(app)).toEqual([
    "Check the iOS path",
    "Then the Android path",
    "A new message",
  ]);
});

test("editing a queued attachment keeps its file and leaves the composer draft alone", async () => {
  const { app, message } = await openBusy();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["hello"], "trace.txt", { type: "text/plain" }),
  );
  await userEvent.type(message, "Review this trace{Enter}");
  await waitFor(() => expect(pills()).toHaveLength(1));
  const before = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  await userEvent.type(message, "Keep this draft");
  await userEvent.click(await queuedEditButton());
  const editor = await screen.findByRole("textbox", { name: "Queued message text" });
  await userEvent.clear(editor);
  await userEvent.type(editor, "Review only errors{Control>}{Enter}{/Control}");
  await waitFor(async () => expect(await daemonQueue(app)).toEqual(["Review only errors"]));
  const after = await app.client.request({ type: "queue.get", threadId: ThreadId.parse(threadId) });
  expect(after.queue.messages[0]?.context?.attachments).toEqual(
    before.queue.messages[0]?.context?.attachments,
  );
  expect(message.textContent).toBe("Keep this draft");
});

test("an edit stays available to copy after another device dispatches the message", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Check retries{Enter}");
  const queued = await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.click(await queuedEditButton(queued));
  const editor = await screen.findByRole("textbox", { name: "Queued message text" });
  await userEvent.clear(editor);
  await userEvent.type(editor, "Keep my revised wording");
  const { queue } = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  const entry = queue.messages[0];
  if (!entry) throw new Error("no queued message");
  await act(async () => {
    await app.client.command(
      {
        type: "queue.edit",
        threadId: queue.threadId,
        expectedRevision: queue.revision,
        messageId: entry.id,
        input: entry.input,
        delivery: "steer",
      },
      {},
      "other-device-steer",
    );
  });
  await screen.findByText("This message has left the queue. Your edits are still here to copy.");
  expect(editor).toHaveProperty("value", "Keep my revised wording");
  expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(true);
  expect(await daemonQueue(app)).toEqual([]);
});

test("a refused edit keeps the unsaved text and the original queued message", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Original wording{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  await userEvent.click(await queuedEditButton());
  const editor = await screen.findByRole("textbox", { name: "Queued message text" });
  await userEvent.clear(editor);
  await userEvent.type(editor, "Unsaved revision");
  app.daemon.refuseCommands("queue_conflict", "queue.edit");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByRole("alertdialog", { name: "Couldn't save the message" });
  expect(editor).toHaveProperty("value", "Unsaved revision");
  expect(await daemonQueue(app)).toEqual(["Original wording"]);
});

test("a held queue explains why steering is disabled", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Wait here{Enter}");
  await screen.findByRole("list", { name: "Queued messages" });
  const { queue } = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  await act(async () => {
    await app.client.command(
      { type: "queue.pause", threadId: queue.threadId, expectedRevision: queue.revision },
      {},
      "hold-queue",
    );
  });
  const steer = screen.getByRole("button", { name: "Steer" });
  await waitFor(() => expect(steer.getAttribute("aria-disabled")).toBe("true"));
  expect(steer.getAttribute("aria-description")).toBe("Resume the queue before steering.");
  await userEvent.click(steer);
  expect(await daemonQueue(app)).toEqual(["Wait here"]);
});

test("loading more keeps every queued message beyond the first page reachable", async () => {
  const { app } = await openBusy();
  await act(async () => {
    for (let index = 0; index < 35; index++)
      await app.client.command(
        {
          type: "thread.send",
          threadId: ThreadId.parse(threadId),
          input: [{ type: "text", text: `Queued ${index}` }],
          delivery: "queue",
        },
        {},
        `page-message-${index}`,
      );
  });
  await waitFor(() => expect(pills()).toHaveLength(16));
  await userEvent.click(await screen.findByRole("button", { name: "Load more queued messages" }));
  await waitFor(() => expect(pills()).toHaveLength(32));
  await userEvent.click(screen.getByRole("button", { name: "Load more queued messages" }));
  await waitFor(() => expect(pills()).toHaveLength(35));
  const beforeHead = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  const before = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
    expectedRevision: beforeHead.queue.revision,
    after: CommandId.parse("page-message-31"),
    limit: 32,
  });
  expect(
    before.queue.messages.flatMap((entry) =>
      entry.input.filter((part) => part.type === "text").map((part) => part.text),
    ),
  ).toContain("Queued 34");
  const last = within(screen.getByRole("list", { name: "Queued messages" }))
    .getAllByRole("listitem")
    .at(-1);
  if (!last) throw new Error("no last row");
  await userEvent.click(within(last).getByRole("button", { name: "Remove queued message" }));
  await waitFor(() => expect(pills()).toHaveLength(34));
  const afterHead = await waitFor(async () => {
    const head = await app.client.request({
      type: "queue.get",
      threadId: ThreadId.parse(threadId),
    });
    expect(head.queue.total).toBe(34);
    return head;
  });
  const after = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
    expectedRevision: afterHead.queue.revision,
    after: CommandId.parse("page-message-31"),
    limit: 32,
  });
  expect(after.queue.total).toBe(34);
  expect(
    after.queue.messages.flatMap((entry) =>
      entry.input.filter((part) => part.type === "text").map((part) => part.text),
    ),
  ).not.toContain("Queued 34");
});

test("saved messages beyond the visible page do not reappear as saving rows or transcript bubbles", async () => {
  const { app, feed, message } = await openBusy();
  for (let index = 0; index < 18; index++)
    await userEvent.type(message, `Follow-up ${index}{Enter}`);
  await waitFor(() => expect(pills()).toHaveLength(16));
  await screen.findByText("2 more queued messages");
  expect(within(feed).queryByText("Follow-up 17")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Load more queued messages" }));
  await waitFor(() => expect(pills()).toHaveLength(18));
  const last = within(screen.getByRole("list", { name: "Queued messages" }))
    .getAllByRole("listitem")
    .at(-1);
  if (!last) throw new Error("no last row");
  await userEvent.click(await queuedEditButton(last));
  expect(await screen.findByRole("textbox", { name: "Queued message text" })).toHaveProperty(
    "value",
    "Follow-up 17",
  );
  expect(
    (await app.client.request({ type: "queue.get", threadId: ThreadId.parse(threadId) })).queue
      .total,
  ).toBe(18);
});

test.each([17, 33, 257])(
  "a fresh client can take back retained input %i without running earlier messages",
  async (count) => {
    const queuedCount = Math.min(count, 256);
    const inputs = Array.from({ length: queuedCount }, (_, index) => `Retained input ${index + 1}`);
    if (count > 256) inputs.unshift("Unconfirmed input");
    const lastInput = `Retained input ${queuedCount}`;
    const app = harness();
    app.play(replayCursor()).runThrough("finding");
    app.daemon.holdQueue(threadId, "manual");
    const { fakeClient } = await import("@/test/harness.tsx");
    const peer = fakeClient(app.daemon);
    try {
      await peer.start();
      await waitFor(() => expect(peer.state).toBe("ready"));
      for (let index = 1; index <= queuedCount; index++)
        await peer.command({
          type: "thread.send",
          threadId: ThreadId.parse(threadId),
          input: [{ type: "text", text: `Retained input ${index}` }],
          delivery: "queue",
        });
      if (count > 256)
        app.daemon.restoreUncertainInput(threadId, {
          id: "unconfirmed-first",
          input: [{ type: "text", text: "Unconfirmed input" }],
          delivery: "queue",
          state: "uncertain",
        });
      await app.open(`/t/${threadId}`);
      await screen.findByRole("list", { name: "Queued messages" });
      expect(
        within(screen.getByRole("feed", { name: "Transcript" })).queryByText(lastInput),
      ).toBeNull();
      for (let shown = 16; shown < count; shown += 16)
        await userEvent.click(
          await screen.findByRole("button", { name: "Load more queued messages" }),
        );
      const last = await within(screen.getByRole("list", { name: "Queued messages" })).findByText(
        lastInput,
      );
      const row = last.closest("li");
      if (!row) throw new Error("Missing queued row");
      await userEvent.click(await takeBackButton(row));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Message" }).textContent).toContain(lastInput),
      );
      const remaining = await peer.request({
        type: "queue.get",
        threadId: ThreadId.parse(threadId),
        limit: 32,
      });
      expect(remaining.queue.total).toBe(count - 1);
      expect(
        remaining.queue.messages.flatMap((entry) =>
          entry.input.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        ),
      ).toEqual(inputs.slice(0, -1).slice(0, 32));
    } finally {
      await peer.close();
    }
  },
);

test("an explicit effort change disables promotion while an ordinary queued follow-up stays steerable", async () => {
  const { app, message } = await openBusy();
  await userEvent.type(message, "Ordinary follow-up{Enter}");
  const ordinary = await screen.findByRole("list", { name: "Queued messages" });
  await waitFor(() =>
    expect(
      within(ordinary).getByRole("button", { name: "Steer" }).getAttribute("aria-disabled"),
    ).toBe("false"),
  );
  const effort = await openEffortControl();
  await chooseEffort(effort, "{End}");
  await closeModelControl();
  await userEvent.type(message, "High effort next turn{Enter}");
  await within(ordinary).findByText("High effort next turn");
  const row = within(ordinary)
    .getAllByRole("listitem")
    .find((entry) => entry.textContent?.includes("High effort next turn"));
  if (!row) throw new Error("Missing selected follow-up");
  await waitFor(() =>
    expect(
      within(row).getByRole("button", { name: "Steer" }).getAttribute("aria-description"),
    ).toBe("This message changes model or turn options and must wait for the next turn."),
  );
  await userEvent.click(within(row).getByRole("button", { name: "Steer" }));
  expect(await daemonQueue(app)).toEqual(["Ordinary follow-up", "High effort next turn"]);
});
