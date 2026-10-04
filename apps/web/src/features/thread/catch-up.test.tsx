import { catchUpSummaryRequest } from "@ace/ui-core";
import { multiDayDemo } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

const threadId = "thread-multi-day";
const day = 24 * 60 * 60 * 1000;

/**
 * Six turns; this device (the harness's "test-device") last read the thread after
 * checkpoint 3's answer. `pending` leaves a seventh turn waiting on an approval.
 */
function awayFromThread(options: { pending?: boolean } = {}) {
  let now = 10 * day;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo(threadId, 6, { scans: 2 })).runUntilBlocked();
  app.daemon.markReadThrough(threadId, "answer-3", "test-device");
  if (options.pending)
    app.daemon.apply(threadId, [
      { type: "turn.started", agent: "root", nativeTurnId: "turn-7", trigger: "user" },
      {
        type: "interaction.opened",
        agent: "root",
        interaction: "approve-rollout",
        blocking: true,
        request: {
          kind: "approval",
          title: "Roll the migration out to production",
          options: [
            { id: "allow", label: "Allow once", kind: "allow_once" },
            { id: "deny", label: "Deny", kind: "deny" },
          ],
        },
      },
    ]);
  return app;
}

test("returning to a thread shows what happened since this device last read it", async () => {
  const app = awayFromThread();
  await app.open(`/t/${threadId}`);
  const card = await screen.findByRole("region", { name: "While you were away" });
  // Checkpoints 4 to 6 finished after the reader left (3 settled after its answer too).
  expect(card.textContent).toMatch(/[34] turns finished/);
  expect(card.textContent).toContain("Done");
  expect(card.textContent).toContain("Every agent has finished");
  expect(card.textContent).toMatch(/Ran [34] commands/);
  expect(card.textContent).toContain("Latest: Checkpoint 6 completed.");
  expect(within(card).getByRole("button", { name: "Open Changes" })).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "While you were away" })).toBeNull(),
  );
});

test("a thread with nothing new since the last read shows no catch-up", async () => {
  let now = 10 * day;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo(threadId, 3, { scans: 2 })).runUntilBlocked();
  // This device read it to the end before (another visit).
  void app.client.start();
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await app.client.markThreadRead({ threadId, lastSeenSeq: app.daemon.head });
  await app.open(`/t/${threadId}`);
  await screen.findByRole("feed", { name: "Transcript" });
  // Give the card's reads time to settle before asserting it stays away.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(screen.queryByRole("region", { name: "While you were away" })).toBeNull();
});

test("an approval waiting since the reader left is answered from the card", async () => {
  const app = awayFromThread({ pending: true });
  await app.open(`/t/${threadId}`);
  const card = await screen.findByRole("region", { name: "While you were away" });
  expect(card.textContent).toContain("Needs you");
  const waiting = within(card).getByRole("list", { name: "Waiting on you" });
  expect(waiting.textContent).toContain("Roll the migration out to production");
  expect(app.daemon.isPending(threadId, "approve-rollout")).toBe(true);

  await userEvent.click(within(waiting).getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(app.daemon.isPending(threadId, "approve-rollout")).toBe(false));
  expect(app.daemon.resolution(threadId, "approve-rollout")).toEqual({
    kind: "approval",
    optionId: "allow",
  });
});

test("Summarise sends the agent one ordinary message, and only when asked", async () => {
  const app = awayFromThread();
  await app.open(`/t/${threadId}`);
  const card = await screen.findByRole("region", { name: "While you were away" });
  const feed = screen.getByRole("feed", { name: "Transcript" });
  // Reading the catch-up asked nothing of the agent.
  expect(within(feed).queryByText(catchUpSummaryRequest)).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Summarise" }));
  expect(await within(feed).findByText(catchUpSummaryRequest)).toBeTruthy();
});

test("following the live end marks the thread read on this device", async () => {
  const app = awayFromThread();
  await app.open(`/t/${threadId}`);
  await screen.findByRole("region", { name: "While you were away" });
  await waitFor(
    async () => {
      const state = await app.client.threadReadState({ threadId });
      expect(state.lastSeenSeq).toBe(app.daemon.head);
    },
    { timeout: 3_000 },
  );
});
