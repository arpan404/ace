import { longHistory } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
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

async function failedStart(options: { behind?: string } = {}) {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.sessionOpenFailed(id, "not_sent");
  app.daemon.holdQueue(id, "not_sent", {
    code: "delivery_failed",
    title:
      "The provider could not accept your message. Check your connection and sign-in, then try again.",
  });
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

test("Edit takes the failed message back into the composer and out of the queue", async () => {
  const { app, item } = await failedStart();
  await userEvent.click(within(item).getByRole("button", { name: "Edit" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Message not sent" })).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("hi"),
  );
  expect((await queued(app)).messages).toEqual([]);
});

test("Remove drops the failed message without sending it", async () => {
  const { app, item } = await failedStart();
  await userEvent.click(within(item).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Message not sent" })).toBeNull(),
  );
  expect((await queued(app)).messages).toEqual([]);
  expect(within(screen.getByRole("feed", { name: "Transcript" })).queryByText("hi")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});
