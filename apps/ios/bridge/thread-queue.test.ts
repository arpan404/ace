// oxlint-disable-next-line import/no-unassigned-import -- Install the test host before the bridge reads it.
import "./test-host.ts";
import type { ClientCore, ThreadSource } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { QueueFollower } from "./thread-queue.ts";

test("a queue read that fails before the socket is ready waits for the next change instead of spinning", async () => {
  let calls = 0;
  // Before the welcome a request fails at once, as the SDK's does without a connection.
  const client = {
    request: () => {
      calls++;
      // Bound the old behaviour so a regression fails this test instead of hanging it.
      if (calls > 100) return new Promise(() => {});
      return Promise.reject(new Error("offline"));
    },
  } as unknown as ClientCore;
  // A thread painted from the copy kept at the last launch already knows its queue revision.
  const store = { queue: { revision: 3 } } as unknown as ThreadSource;
  const follower = new QueueFollower(
    client,
    store,
    ThreadId.parse("thread"),
    new AbortController().signal,
    () => {},
  );
  follower.update();
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(1);
  // The reader's next change (the daemon's snapshot once connected) reads again.
  follower.update();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(2);
});
