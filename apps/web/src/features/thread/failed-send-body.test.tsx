import { longHistory } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkPanel } from "@/test/open-work.ts";
import { resetDismissed } from "./composer/dismissed-sends.ts";
import { resetSendStore } from "./composer/send-store.ts";

/*
 * A send whose provider session couldn't start (owner UI rule, 2026-10-13): the failed message
 * shows in the thread body where it was written, with a short reason, the technical detail
 * behind Details, and Try again / Edit / Remove. The composer's strip never carries the error.
 */

beforeEach(() => {
  localStorage.clear();
  resetSendStore();
  resetDismissed();
});

const id = ThreadId.parse("thread-router");
const technical =
  "OpenCode startup failed: OpenCode 2.0.40 changed the API ace uses (session.prompt is missing)";

function queue(app: ReturnType<typeof harness>, commandId: string, text: string) {
  app.daemon.command({
    id: CommandId.parse(commandId),
    deviceId: DeviceId.parse("phone"),
    payload: {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text }],
      delivery: "queue",
    },
  });
}

const providerRefused = {
  code: "delivery_failed",
  title:
    "The provider could not accept your message. Check your connection and sign-in, then try again.",
};

async function failedStart(options: { behind?: string; failure?: typeof providerRefused } = {}) {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.sessionOpenFailed(id, "not_sent");
  app.daemon.holdQueue(id, "not_sent", options.failure ?? providerRefused);
  queue(app, "queued-hi", "hi");
  if (options.behind) queue(app, "queued-behind", options.behind);
  app.daemon.apply(id, [
    {
      type: "item.upsert",
      agent: "root",
      item: "intent:queued-hi",
      draft: {
        type: "notice",
        level: "info",
        text: "Message kept in queue",
        title: "Message kept in queue",
        code: "input_queued",
        commandId: CommandId.parse("queued-hi"),
        detail: technical,
        complete: true,
      },
    },
  ]);
  await app.open(`/t/${id}`);
  const item = await screen.findByRole("region", { name: "Message not sent" });
  // The kept message joins its line once the queue page is read.
  await within(item).findByText("hi");
  return { app, item };
}

async function queued(app: ReturnType<typeof harness>) {
  const reply = await app.client.request({ type: "queue.get", threadId: id });
  return reply.queue;
}

test("a send that couldn't start shows in the transcript with its message, one short reason and the detail behind Details", async () => {
  const { item } = await failedStart();
  expect(within(item).getByText("hi")).toBeTruthy();
  expect(within(item).getByText("Not sent")).toBeTruthy();
  expect(within(item).getByText("· The provider could not accept your message")).toBeTruthy();
  const details = within(item).getByText("Details").closest("details");
  expect(details?.open).toBe(false);
  await userEvent.click(within(item).getByText("Details"));
  expect(details?.open).toBe(true);
  expect(within(item).getByText(technical)).toBeTruthy();
  // Said once, in the body: the technical text isn't repeated anywhere else.
  expect(screen.getAllByText(technical)).toHaveLength(1);
});

test("the composer strip lists only what waits behind a failed send, with no error text", async () => {
  const { item } = await failedStart({ behind: "also check the logs" });
  const strip = await screen.findByRole("region", { name: "Message queue" });
  const list = within(strip).getByRole("list", { name: "Queued messages" });
  expect(within(list).getByText("also check the logs")).toBeTruthy();
  expect(within(list).queryByText("hi")).toBeNull();
  expect(strip.textContent).not.toMatch(/not sent|could not accept|OpenCode startup failed/i);
  expect(within(strip).queryByRole("button", { name: "Try again" })).toBeNull();
  expect(within(item).getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("with nothing else queued, a failed send leaves the composer strip empty", async () => {
  await failedStart();
  expect(screen.queryByRole("region", { name: "Message queue" })).toBeNull();
  expect(screen.queryByText(/could not accept/)).toBeTruthy();
  expect(screen.getAllByText(/could not accept/)).toHaveLength(1);
});

test("the Summary never lists a failed send as queued or says it sends when the agent is free", async () => {
  await failedStart();
  const work = await openWorkPanel();
  // The thread still waits on the retained message; the failed item alone stands for it.
  await waitFor(() => expect(work.textContent).not.toMatch(/queued message/i));
  expect(work.textContent).not.toMatch(/when the agent is free/);
  expect(within(work).queryByRole("region", { name: "Background" })).toBeNull();
});

test("the Summary counts only what waits behind a failed send, waiting for it", async () => {
  await failedStart({ behind: "also check the logs" });
  const work = await openWorkPanel();
  const background = await within(work).findByRole("region", { name: "Background" });
  expect(
    within(background).getByRole("listitem", {
      name: "1 queued message: waits for the message that wasn't sent",
    }),
  ).toBeTruthy();
  expect(background.textContent).not.toMatch(/when the agent is free/);
});

test("Try again sends the kept message: it joins the transcript and the agent starts", async () => {
  const { app, item } = await failedStart();
  await userEvent.click(within(item).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Message not sent" })).toBeNull(),
  );
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  expect(within(screen.getByRole("feed", { name: "Transcript" })).getByText("hi")).toBeTruthy();
  expect((await queued(app)).messages).toEqual([]);
});

const words = (message: { input: readonly { type: string; text?: string }[] }) =>
  message.input.map((part) => part.text ?? "").join("");

test("Edit changes the failed message's words where it waits: nothing leaves the queue", async () => {
  const { app, item } = await failedStart({ behind: "then the tests" });
  const before = await queued(app);
  await userEvent.click(within(item).getByRole("button", { name: "Edit" }));
  const composer = screen.getByRole("combobox", { name: "Message" });
  await waitFor(() => expect(composer.textContent).toBe("hi"));
  await userEvent.type(composer, " there{Enter}");
  await within(item).findByText("hi there");
  const after = await queued(app);
  // The same messages in the same places; only its words changed, and it is still not sent.
  expect(after.messages.map((message) => message.id)).toEqual(
    before.messages.map((message) => message.id),
  );
  expect(after.messages.map(words)).toEqual(["hi there", "then the tests"]);
  expect(within(item).getByText("Not sent")).toBeTruthy();
});

test("an edit of a message another device changed first keeps the edit and shows what it says now", async () => {
  const { app, item } = await failedStart();
  await userEvent.click(within(item).getByRole("button", { name: "Edit" }));
  const composer = screen.getByRole("combobox", { name: "Message" });
  await waitFor(() => expect(composer.textContent).toBe("hi"));
  // Another device saves its own words first.
  const page = await queued(app);
  const changed = await app.client.command({
    type: "queue.edit",
    threadId: id,
    expectedRevision: page.revision,
    messageId: CommandId.parse("queued-hi"),
    input: [{ type: "text", text: "hello from the laptop" }],
  });
  expect(changed.ok).toBe(true);
  await userEvent.type(composer, " there{Enter}");
  const notice = await screen.findByRole("status", { name: "Changed on another device" });
  expect(within(notice).getByText("hello from the laptop")).toBeTruthy();
  expect(composer.textContent).toBe("hi there");
  expect((await queued(app)).messages.map(words)).toEqual(["hello from the laptop"]);
  // Saving again replaces what it says now, on purpose.
  await userEvent.type(composer, "{Enter}");
  await waitFor(async () => expect((await queued(app)).messages.map(words)).toEqual(["hi there"]));
});

test("Remove asks first, then drops the failed message without sending it", async () => {
  const { app, item } = await failedStart();
  await userEvent.click(within(item).getByRole("button", { name: "Remove" }));
  const confirm = await screen.findByRole("dialog", { name: "Remove this message?" });
  expect((await queued(app)).messages.map((message) => message.id)).toEqual(["queued-hi"]);
  await userEvent.click(within(confirm).getByRole("button", { name: "Remove message" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Message not sent" })).toBeNull(),
  );
  expect((await queued(app)).messages).toEqual([]);
  expect(within(screen.getByRole("feed", { name: "Transcript" })).queryByText("hi")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});

test("a send a stale Git lock stopped offers Clear stale lock, which asks first, then clears it", async () => {
  const { item } = await failedStart({
    failure: {
      code: "git_quarantined",
      title:
        "A stale Git lock blocks this checkout. If nothing is still changing it, clear the stale lock, then try again.",
    },
  });
  expect(within(item).getByText("· A stale Git lock blocks this checkout")).toBeTruthy();
  await userEvent.click(within(item).getByRole("button", { name: "Clear stale lock" }));
  const dialog = await screen.findByRole("dialog", { name: "Clear the stale Git lock?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("Lock cleared")).toBeNull();
  await userEvent.click(within(item).getByRole("button", { name: "Clear stale lock" }));
  const confirm = await screen.findByRole("dialog", { name: "Clear the stale Git lock?" });
  await userEvent.click(within(confirm).getByRole("button", { name: "Clear lock" }));
  expect(await screen.findByText("Lock cleared")).toBeTruthy();
});

test("a send the provider refused offers no Clear stale lock", async () => {
  const { item } = await failedStart();
  expect(within(item).queryByRole("button", { name: "Clear stale lock" })).toBeNull();
});
