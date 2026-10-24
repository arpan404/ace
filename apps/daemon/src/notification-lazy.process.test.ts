import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { notificationsRetained, type DeliveryResult } from "@ace/notify";
import { DeviceId, type Notification, type ThreadId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { createDaemonNotifications } from "./notifications.ts";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const browser = DeviceId.parse("browser");
const desktop = DeviceId.parse("desktop");
const subscription = {
  channel: "webpush",
  platform: "web",
  subscription: {
    endpoint: "https://push.example.test/subscription",
    p256dh: "a".repeat(87),
    auth: "b".repeat(22),
  },
} as const;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-lazy-"));
  const store = new Store(join(home, "events.sqlite"));
  const workspace = store.createWorkspace("/repo", "Repo");
  const workers: Worker[] = [];
  const exited: Worker[] = [];
  const spawn = (entry: URL, options: ConstructorParameters<typeof Worker>[1]) => {
    const worker = new Worker(entry, options);
    workers.push(worker);
    worker.once("exit", () => exited.push(worker));
    return worker;
  };
  cleanups.push(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const needsYou = (thread: ThreadId, at?: number) =>
    store.appendEvents(
      thread,
      [
        { type: "thread.updated", status: { state: "working", agents: 1 } },
        { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
      ],
      at,
    );
  return {
    home,
    store,
    workers,
    exited,
    spawn,
    needsYou,
    thread: () => createDevThread(store, workspace).id,
    path: join(home, "notifications.sqlite"),
  };
}

test("no worker starts until a device subscribes, and its first alert arrives without polling", async () => {
  const f = setup();
  const thread = f.thread();
  const pushed: Notification[] = [];
  const errors: unknown[] = [];
  const notifications = createDaemonNotifications(
    f.home,
    f.store,
    (error) => errors.push(error),
    {
      webpush: {
        async send(_device, notification) {
          pushed.push(notification);
          return "accepted";
        },
      },
    },
    0,
    { spawn: f.spawn, slept: !notificationsRetained(f.path) },
  );
  cleanups.push(() => notifications.close());
  notifications.activate();
  f.store.appendEvents(thread, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.workers).toHaveLength(0);

  await notifications.service.register(browser, subscription);
  expect(f.workers).toHaveLength(1);
  f.store.appendEvents(thread, [
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  await vi.waitFor(() => expect(pushed.map((alert) => alert.status)).toEqual(["needs_you"]));
  expect(errors).toEqual([]);
});

test("a worker that slept replays what it missed: stale alerts stay quiet, recent ones arrive once", async () => {
  const f = setup();
  const stale = f.thread(),
    recent = f.thread(),
    later = f.thread();
  const received: Notification[] = [];
  let connected: DeviceId[] = [desktop];
  const errors: unknown[] = [];
  const notifications = createDaemonNotifications(
    f.home,
    f.store,
    (error) => errors.push(error),
    {},
    0,
    { spawn: f.spawn, slept: true, quietMs: 20 },
  );
  cleanups.push(() => notifications.close());
  notifications.setSender((device, notification) => {
    if (!connected.includes(device)) return false;
    received.push(notification);
    return true;
  });
  notifications.setConnected(() => connected);
  notifications.activate();
  await notifications.service.connectDevice(desktop);
  expect(f.workers).toHaveLength(1);

  // The desktop leaves; with nothing queued and nobody connected, the worker stops.
  connected = [];
  await vi.waitFor(() => expect(f.exited).toHaveLength(1));
  f.needsYou(stale, Date.now() - 3_600_000);
  f.needsYou(recent);
  expect(received).toEqual([]);

  connected = [desktop];
  await notifications.service.connectDevice(desktop);
  expect(f.workers).toHaveLength(2);
  expect(await notifications.service.cursor()).toBe(f.store.headSeq());
  await vi.waitFor(() => expect(received.map((alert) => alert.threadId)).toEqual([recent]));

  f.needsYou(later);
  await vi.waitFor(() => expect(received.map((alert) => alert.threadId)).toEqual([recent, later]));
  // Nothing arrives twice once delivery has settled.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(received.map((alert) => alert.threadId)).toEqual([recent, later]);
  expect(errors).toEqual([]);
});

test("a retry scheduled before a restart fires on time after it", async () => {
  const f = setup();
  const thread = f.thread();
  const attempts: { at: number; result: DeliveryResult }[] = [];
  const create = (result: DeliveryResult, slept: boolean) =>
    createDaemonNotifications(
      f.home,
      f.store,
      () => {},
      {
        webpush: {
          async send() {
            attempts.push({ at: Date.now(), result });
            return result;
          },
        },
      },
      0,
      { spawn: f.spawn, slept },
    );

  const first = create("retry", true);
  first.activate();
  await first.service.register(browser, subscription);
  f.needsYou(thread);
  await vi.waitFor(() => expect(attempts).toHaveLength(1));
  await first.close();
  expect(notificationsRetained(f.path)).toBe(true);

  const second = create("accepted", !notificationsRetained(f.path));
  cleanups.push(() => second.close());
  await second.start();
  await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 4000 });
  const [failed, retried] = attempts;
  expect(retried?.result).toBe("accepted");
  // The first retry waits one to one and a quarter seconds.
  expect((retried?.at ?? 0) - (failed?.at ?? 0)).toBeGreaterThanOrEqual(1000);
  expect((retried?.at ?? 0) - (failed?.at ?? 0)).toBeLessThan(2500);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(attempts).toHaveLength(2);
});
