import { afterEach, expect, test, vi } from "vitest";
import type { Notification } from "@ace/protocol";
import { createDaemonNotifications } from "./notifications.ts";
import { notificationFixture, retainNotifications } from "./notification-test-support.ts";

// A real worker thread is the edge: the retry must wake it once, not once per attempt.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test("a warmup that failed to wake the worker resumes on the next run: one worker, delivery starts once", async () => {
  const f = notificationFixture(cleanups);
  await retainNotifications(f.home);
  const thread = f.thread();
  const pushed: Notification[] = [];
  let spawns = 0;
  const notifications = createDaemonNotifications(
    f.home,
    f.store,
    () => {},
    {
      webpush: {
        async send(_device, notification) {
          pushed.push(notification);
          return "accepted";
        },
      },
    },
    0,
    {
      slept: false,
      spawn: (entry, options) => {
        if (++spawns === 1) throw new Error("worker could not start");
        return f.spawn(entry, options);
      },
    },
  );
  cleanups.push(() => notifications.close());
  // The warmup the service repeats: wake the worker, then start delivering.
  const warmup = async () => {
    await notifications.ready();
    notifications.activate();
  };
  await expect(warmup()).rejects.toThrow("worker could not start");
  await warmup();
  notifications.activate();
  expect(f.workers).toHaveLength(1);

  f.store.appendEvents(thread, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  f.store.appendEvents(thread, [
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  await vi.waitFor(() => expect(pushed.map((alert) => alert.status)).toEqual(["needs_you"]));
});
