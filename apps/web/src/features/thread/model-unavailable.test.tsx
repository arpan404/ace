import { longHistory } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const id = ThreadId.parse("thread-router");
const model = "opencode-go/muse-spark-1.3-contributor";

async function blocked(reason: "model_unavailable" | "not_sent") {
  const app = harness();
  app.play(longHistory(2)).runUntilBlocked();
  app.daemon.command({
    id: CommandId.parse("pin-model"),
    deviceId: DeviceId.parse("phone"),
    payload: {
      type: "thread.switch",
      threadId: id,
      selection: { provider: "opencode", model },
    },
  });
  app.daemon.sessionOpenFailed(id, reason);
  app.daemon.command({
    id: CommandId.parse("queued-hi"),
    deviceId: DeviceId.parse("phone"),
    payload: {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "hi" }],
      delivery: "queue",
    },
  });
  // Older versions persisted a failure even though the input was still retained.
  app.daemon.apply(id, [
    {
      type: "item.upsert",
      agent: "root",
      item: "legacy-delivery-failure",
      draft: {
        type: "notice",
        level: "error",
        text: "Message not sent",
        title: "Not sent",
        code: "delivery_failed",
        commandId: CommandId.parse("queued-hi"),
        complete: true,
      },
    },
  ]);
  if (reason === "model_unavailable")
    app.daemon.services.models = app.daemon.services.models.filter((row) => row.id !== model);
  await app.open(`/t/${id}`);
  await screen.findByRole("list", { name: "Queued messages" });
  return app;
}

test("a vanished model shows one actionable notice and picking a replacement sends the kept message", async () => {
  const app = await blocked("model_unavailable");
  const notice = await screen.findByRole("region", {
    name: "Muse Spark 1.3 Contributor isn't available in OpenCode anymore — pick another model",
  });
  expect(
    screen.getByRole("button", { name: /^Model: Muse Spark 1.3 Contributor, Unavailable/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByText("Working")).toBeNull();
  expect(screen.queryByText("Not sent")).toBeNull();
  await userEvent.click(within(notice).getByRole("button", { name: "Pick another model" }));
  const search = await screen.findByRole("combobox", { name: "Search models" });
  const old = await screen.findByRole("option", {
    name: /Muse Spark 1.3 Contributor, Unavailable/,
  });
  expect(old.getAttribute("aria-disabled")).toBe("true");
  await userEvent.type(search, "Opus");
  const replacement = await screen.findByRole("option", { name: /Opus.*recommended, OpenCode/ });
  await userEvent.click(replacement);
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: /isn't available in OpenCode anymore/ }),
    ).toBeNull(),
  );
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull();
  expect(within(screen.getByRole("feed", { name: "Transcript" })).getByText("hi")).toBeTruthy();
  expect(screen.queryByText("Not sent")).toBeNull();
  const snapshot = app.daemon.snapshot({ kind: "thread", threadId: id });
  expect(snapshot?.kind === "thread" && snapshot.thread.status.state).toBe("working");
});

test("a not-sent message has one retry notice and no active work until retried", async () => {
  const app = await blocked("not_sent");
  // A repeated pre-delivery failure keeps the same message and retry state.
  act(() => app.daemon.sessionOpenFailed(id, "not_sent"));
  expect(await screen.findByRole("region", { name: "Message not sent" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.queryByText("Working")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
});

test("a restart with queued input offers only continuation until it resumes", async () => {
  const app = await blocked("not_sent");
  act(() => app.daemon.holdQueue(id, "restart"));
  const notice = await screen.findByRole("region", { name: "Stopped by a restart" });
  expect(screen.queryByText("Working")).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Message not sent" })).toBeNull();
  await userEvent.click(within(notice).getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
});
