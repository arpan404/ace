import { multiDayDemo } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
const threadId = "thread-multi-day";
function awayFromThread() {
  let now = 10 * 24 * 60 * 60 * 1000;
  const app = harness({ snapshotItems: 40, clock: () => (now += 1) });
  app.play(multiDayDemo(threadId, 6, { scans: 2 })).runUntilBlocked();
  app.daemon.markReadThrough(threadId, "answer-3", "test-device");
  return app;
}

test("returning to a thread never fetches or offers an automatic summary", async () => {
  const app = awayFromThread();
  const digest = vi.spyOn(app.client, "threadCatchUp");
  const before = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  if (before?.kind !== "thread") throw new Error("Missing thread");
  const inputs = Object.values(before.items).filter(
    (item) => item.type === "message" && item.role === "user",
  );
  await app.open(`/t/${threadId}`);
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  await within(feed).findByText(
    "Checkpoint 6 completed. Migration paths validated; all commands passed.",
  );
  await app.client.threadReadState({ threadId });
  expect(screen.queryByRole("region", { name: "While you were away" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Summarise" })).toBeNull();
  expect(digest).not.toHaveBeenCalled();
  const after = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(threadId) });
  expect(
    after?.kind === "thread" &&
      Object.values(after.items).filter((item) => item.type === "message" && item.role === "user"),
  ).toEqual(inputs);
});

test("following the live end still marks the thread read on this device", async () => {
  const app = awayFromThread();
  await app.open(`/t/${threadId}`);
  await screen.findByRole("feed", { name: "Transcript" });
  await waitFor(
    async () => {
      const state = await app.client.threadReadState({ threadId });
      expect(state.lastSeenSeq).toBe(app.daemon.head);
    },
    { timeout: 3_000 },
  );
});
