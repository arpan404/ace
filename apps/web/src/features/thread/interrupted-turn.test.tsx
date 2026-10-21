import { interruptedTurn } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const id = "thread-interrupted-turn";

/** A daemon clock far enough from zero that the script's backdated steps keep their spacing. */
function clocked() {
  let now = 100_000;
  return harness({ clock: () => (now += 1) });
}

async function interrupted() {
  const app = clocked();
  app.play(interruptedTurn(id)).runUntilBlocked();
  app.daemon.holdQueue(id, "restart");
  await app.open(`/t/${id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  return { app, feed };
}

test("three refused Stops read as one row with ×3 and the reason inline", async () => {
  const { feed } = await interrupted();
  const rows = await within(feed).findAllByRole("group", { name: /^Couldn't stop the agent/ });
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("Missing failure row");
  expect(within(row).getByText("×3")).toBeTruthy();
  expect(within(row).getByText(/OpenCode had nothing running to stop/)).toBeTruthy();
  expect(within(feed).queryByText("Action failed")).toBeNull();
});

test("a restart reads only in the composer strip with Continue, never in the transcript or queue", async () => {
  const { feed } = await interrupted();
  const strip = await screen.findByRole("region", { name: "Interrupted by a restart" });
  expect(within(strip).getByRole("button", { name: "Continue" })).toBeTruthy();
  // The transcript keeps no interruption row; nothing pretends to be queued or running.
  expect(within(feed).queryByText(/Interrupted/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
});

test("Continue after a restart resumes once and the strip leaves once a turn runs", async () => {
  const { app } = await interrupted();
  // What reaches the daemon over the wire.
  const sent: string[] = [];
  const command = app.daemon.command.bind(app.daemon);
  app.daemon.command = (value) => {
    if ("threadId" in value.payload && value.payload.threadId === id) sent.push(value.payload.type);
    return command(value);
  };
  const strip = await screen.findByRole("region", { name: "Interrupted by a restart" });
  await userEvent.click(within(strip).getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Interrupted by a restart" })).toBeNull(),
  );
  expect(sent.filter((type) => type === "thread.resume")).toHaveLength(1);
  expect(sent.filter((type) => type === "thread.send")).toHaveLength(0);
});

test("Continue on a paused turn sends the person's message and starts the next turn", async () => {
  const app = clocked();
  app.play(interruptedTurn(id)).runUntilBlocked();
  app.daemon.holdQueue(id, "stopped");
  await app.open(`/t/${id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const strip = await screen.findByRole("region", { name: "Paused" });
  await userEvent.click(within(strip).getByRole("button", { name: "Continue" }));
  expect(await within(feed).findByText("Continue where you left off.")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Paused" })).toBeNull();
});

test("a message typed while paused starts the next turn at once, never queued behind the stop", async () => {
  const app = clocked();
  app.play(interruptedTurn(id)).runUntilBlocked();
  app.daemon.holdQueue(id, "stopped");
  await app.open(`/t/${id}`);
  expect(await screen.findByRole("region", { name: "Paused" })).toBeTruthy();
  const box = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(box, "try the other file{Enter}");
  expect(await screen.findByRole("button", { name: "Stop the agent" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Paused" })).toBeNull();
  expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull();
});

test("background commands started back to back read as one group, ended ones only inside it", async () => {
  const app = clocked();
  const script = app.play(interruptedTurn(id));
  script.runThrough("background");
  await app.open(`/t/${id}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const group = await within(feed).findByRole("group", {
    name: "3 background tasks · 1 running",
  });
  // The running one keeps its own line; the two that ended at once get none outside the group.
  expect(within(group).getAllByRole("group", { name: /^Background task / })).toHaveLength(1);
  expect(within(feed).queryByRole("group", { name: "Background task bun run lint" })).toBeNull();

  act(() => script.runThrough("background-done"));
  const done = await within(feed).findByRole("group", { name: "Ran 3 background tasks" });
  await userEvent.click(within(done).getByRole("button", { name: /Ran 3 background tasks/ }));
  expect(
    within(done)
      .getAllByRole("group", { name: /^Background task / })
      .map((line) => line.getAttribute("aria-label")),
  ).toEqual([
    "Background task bun run build",
    "Background task bun run lint",
    "Background task bun run typecheck",
  ]);
});
