import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness, hostId, memory, record, stored } from "./read-snapshots.fixture.ts";

/*
 * Signing out of the ace account (or the machine refusing this account's credential) never
 * deletes what the device kept: its read threads and its queued work wait for the next
 * sign-in. Only the owner revoking a paired device deletes (`read-snapshots.test.ts`).
 */

/** An outbox kept in memory across clients, as a device's storage is across sign-ins. */
function outbox() {
  let saved: string | null = null;
  return {
    storage: {
      load: async () => saved,
      save: async (value: string) => {
        saved = value;
      },
    },
    saved: () => saved,
  };
}

test("signing out then in again shows the same threads from the saved copy and sends the queued work", async () => {
  const snapshots = memory();
  snapshots.values.set(stored("thread:thread"), record());
  const queue = outbox();

  const before = harness(snapshots.storage, 32, { host: hostId, outbox: queue.storage });
  await before.start();
  // Queued, never answered: the machine refuses this account's credential before it does.
  void before.client
    .enqueue({ type: "thread.archive", threadId: ThreadId.parse("thread") })
    .catch(() => {});
  await expect.poll(() => queue.saved()).toContain("thread.archive");
  before.deliver({ type: "error", code: "unauthorized", message: "Valid hello required" });
  await expect.poll(() => before.client.state).toBe("fatal");
  await before.client.close();
  expect(snapshots.values.has(stored("thread:thread"))).toBe(true);
  expect(queue.saved()).toContain("thread.archive");

  // Signed in again: a new client paints the kept thread before the machine answers.
  const after = harness(snapshots.storage, 32, { host: hostId, outbox: queue.storage });
  const lease = after.client.thread("thread");
  await expect.poll(() => lease.store.thread?.title).toBe("Cached");
  expect(after.sent).toEqual([]);
  await after.start();
  await expect
    .poll(() =>
      after.sent.some(
        (message) =>
          message.type === "command" && message.command.payload.type === "thread.archive",
      ),
    )
    .toBe(true);
  await after.client.close();
});
