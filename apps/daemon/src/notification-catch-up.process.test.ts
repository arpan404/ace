import { afterEach, expect, test, vi } from "vitest";
import { desktopDaemon, notificationFixture } from "./notification-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/**
 * The desktop has been seen once, then quits; with nobody connected the worker stops. Threads
 * then start needing the person ten minutes before the desktop returns: long past the window
 * in which a running worker would still have retried the missed alert itself.
 */
async function quitDesktop() {
  const f = notificationFixture(cleanups);
  const desktop = desktopDaemon(f, { quietMs: 20 });
  cleanups.push(() => desktop.notifications.close());
  await desktop.connect();
  desktop.leave();
  await vi.waitFor(() => expect(f.exited).toHaveLength(1));
  return { f, desktop };
}

test("threads that started needing you while the app was quit come back as one alert", async () => {
  const { f, desktop } = await quitDesktop();
  const first = f.thread(),
    second = f.thread();
  f.needsYou(first, Date.now() - 600_000);
  f.needsYou(second, Date.now() - 600_000);

  await desktop.connect();
  await vi.waitFor(() => expect(desktop.received).toHaveLength(1));
  expect(desktop.received[0]).toMatchObject({
    status: "catch_up",
    title: "2 threads need you",
    threadId: first,
    threadIds: [first, second],
  });
  await settle();
  expect(desktop.received).toHaveLength(1);
});

test("a thread answered before the app returns raises no catch-up", async () => {
  const { f, desktop } = await quitDesktop();
  const thread = f.thread();
  f.needsYou(thread, Date.now() - 600_000);
  f.resolved(thread);

  await desktop.connect();
  await settle();
  expect(desktop.received).toEqual([]);
});

test("reconnecting again for the same wait shows nothing more", async () => {
  const { f, desktop } = await quitDesktop();
  const thread = f.thread();
  f.needsYou(thread, Date.now() - 600_000);

  await desktop.connect();
  await vi.waitFor(() => expect(desktop.received).toHaveLength(1));
  await settle();
  // A network drop and back, then a second launch of the app: still the same wait.
  desktop.leave();
  await desktop.connect();
  await settle();
  desktop.leave();
  await desktop.connect();
  await settle();
  expect(desktop.received.map((alert) => alert.status)).toEqual(["catch_up"]);
  expect(desktop.received[0]?.title).toBe("1 thread needs you");
});
