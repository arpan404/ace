import { seedColdStartState } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("legacy OpenCode bookkeeping and replayed native answers stay out of the conversation", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  app.daemon.apply(
    "cold-legacy",
    [
      "Native history record: world_state",
      "Native message",
      "Native content block: input_image",
    ].map((text) => ({
      type: "item.upsert" as const,
      agent: "root",
      item: text,
      draft: { type: "notice" as const, level: "info" as const, text, complete: true },
    })),
  );
  await app.open("/t/cold-legacy");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findAllByText("I checked the reconnect path.")).toHaveLength(1);
  expect(within(feed).getByText("A separate reply stays visible.")).toBeTruthy();
  expect(feed.textContent).not.toMatch(
    /session.permissions|instructions.updated|Internal tool schemas|Native history record|Native message|Native content block/,
  );
});

test("a retained failure names its message and current model availability on the composer", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  await app.open("/t/cold-unsent");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("Which file needs fixing?")).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Message not sent" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Model:.*Unavailable/ })).toBeNull();
  expect(screen.queryByText("Not sent")).toBeNull();
});

test("a retained failed input appears in Activity Needs you", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  await app.open("/activity");
  expect(
    await screen.findAllByRole("link", { name: "Fix the reconnect: Message not sent" }),
  ).not.toHaveLength(0);
});

test("a thread with no prior turn offers the first message without restart recovery", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  await app.open("/t/cold-untouched");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByText("Stopped by a restart")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

test("one input repeated under uncertain and queued states shows one message to review", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  await app.open("/t/cold-uncertain");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getAllByText("yo")).toHaveLength(1);
  expect(within(queue).getByText("May have been sent")).toBeTruthy();
  expect(within(queue).queryByText("Queued", { exact: true })).toBeNull();
});

test("a model waiting for its first catalog never shows Unavailable", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  app.daemon.services.models = app.daemon.services.models.filter(
    (model) => model.provider !== "opencode",
  );
  await app.open("/t/cold-unsent");
  await screen.findByRole("list", { name: "Queued messages" });
  expect(screen.queryByRole("button", { name: /Model:.*Unavailable/ })).toBeNull();
  expect(screen.queryByText(/isn't available in OpenCode/)).toBeNull();
});

test("separate queued inputs with identical text remain individually visible", async () => {
  const app = harness();
  seedColdStartState(app.daemon);
  app.daemon.command({
    id: CommandId.parse("separate-yo"),
    deviceId: DeviceId.parse("fixture"),
    payload: {
      type: "thread.send",
      threadId: ThreadId.parse("cold-uncertain"),
      input: [{ type: "text", text: "yo" }],
      delivery: "queue",
    },
  });
  await app.open("/t/cold-uncertain");
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getAllByText("yo")).toHaveLength(2);
  expect(within(queue).getByText("May have been sent")).toBeTruthy();
  expect(within(queue).getByText("Queued", { exact: true })).toBeTruthy();
});
