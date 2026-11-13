import type { FakeSpadeApi } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { botRow, spadeApp, withEndpoint } from "@/test/spade.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const withSpade = (spade: FakeSpadeApi) => {
  withEndpoint(spade);
  spade.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
};

test("a bot carrying on by itself says so in its chat and its row, and the line goes once it is done", async () => {
  let scout: ReturnType<FakeSpadeApi["addAgent"]> | undefined;
  await spadeApp("/spade", (api) => {
    withSpade(api);
    scout = api.addAgent({
      id: "scout",
      name: "Scout",
      state: "working",
      task_state: { status: "working", note: "Checking easyJet" },
      continuing: true,
    });
  });
  const row = await botRow("Scout");
  await waitFor(() => expect(row.textContent).toContain("Working on it · Checking easyJet"));
  await userEvent.click(row);
  const feed = await screen.findByRole("feed", { name: "Conversation with Scout" });
  await waitFor(() =>
    expect(within(feed).getByRole("status").textContent).toContain(
      "Scout is working on it · Checking easyJet",
    ),
  );
  // Stop stays while it carries on.
  expect(screen.getByRole("button", { name: "Stop the agent" })).toBeTruthy();

  if (scout)
    Object.assign(scout, { state: "idle", task_state: { status: "done" }, continuing: false });
  await waitFor(() => expect(within(feed).queryByRole("status")).toBeNull());
  expect((await botRow("Scout")).textContent).not.toContain("Working on it");
});

test("a task waiting on the person reads that the bot needs you", async () => {
  await spadeApp("/spade", (api) => {
    withSpade(api);
    api.addAgent({ id: "scout", name: "Scout", task_state: { status: "blocked_on_person" } });
  });
  const row = await botRow("Scout");
  await waitFor(() => expect(row.textContent).toContain("Needs you"));
  await userEvent.click(row);
  const feed = await screen.findByRole("feed", { name: "Conversation with Scout" });
  await waitFor(() =>
    expect(within(feed).getByRole("status").textContent).toContain("Scout needs you"),
  );
});

test("a task pause shows once after replay, and continuation nudges stay out of chat", async () => {
  await spadeApp("/spade", (api) => {
    withSpade(api);
    const scout = api.addAgent({ id: "scout", name: "Scout" });
    api.store(scout.conversation, {
      type: "call_reviewed",
      call_id: "refused",
      name: "send_email",
      verdict: "refuse",
      reason: "Refused action reason",
      model: "",
    });
    api.store(scout.conversation, { type: "task_continued", step: 1, nudge: "private nudge" });
    api.store(scout.conversation, { type: "task_paused", reason: "budget", steps: 25 });
  });
  await userEvent.click(await botRow("Scout"));
  const feed = within(await screen.findByRole("feed", { name: "Conversation with Scout" }));
  expect(
    await feed.findAllByText("Paused after 25 steps. Send a message to keep going."),
  ).toHaveLength(1);
  expect(feed.queryByText("private nudge")).toBeNull();
  expect(feed.queryByText("Refused action reason")).toBeNull();
});
