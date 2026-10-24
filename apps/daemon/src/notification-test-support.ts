import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { notificationsRetained } from "@ace/notify";
import { DeviceId, type Notification, type ThreadId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { createDaemonNotifications } from "./notifications.ts";
import { Store } from "./store.ts";

export const browser = DeviceId.parse("browser");
export const desktop = DeviceId.parse("desktop");
export const subscription = {
  channel: "webpush",
  platform: "web",
  subscription: {
    endpoint: "https://push.example.test/subscription",
    p256dh: "a".repeat(87),
    auth: "b".repeat(22),
  },
} as const;

/** A temp home and event store, a counting worker spawner and helpers to move threads. */
export function notificationFixture(cleanups: (() => Promise<void> | void)[]) {
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
  /** The person answered: the thread is back at work. */
  const resolved = (thread: ThreadId) =>
    store.appendEvents(thread, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
    ]);
  return {
    home,
    store,
    workers,
    exited,
    spawn,
    needsYou,
    resolved,
    thread: () => createDevThread(store, workspace).id,
    path: join(home, "notifications.sqlite"),
  };
}

/** A daemon whose desktop is the only device, as the desktop app registers it. */
export function desktopDaemon(
  f: ReturnType<typeof notificationFixture>,
  options: { now?: () => number; quietMs?: number } = {},
) {
  const received: Notification[] = [];
  let connected: DeviceId[] = [];
  const notifications = createDaemonNotifications(f.home, f.store, () => {}, {}, 0, {
    spawn: f.spawn,
    slept: !notificationsRetained(f.path),
    ...options,
  });
  notifications.setSender((device, notification) => {
    if (!connected.includes(device)) return false;
    received.push(notification);
    return true;
  });
  notifications.setConnected(() => connected);
  notifications.activate();
  return {
    notifications,
    received,
    async connect() {
      connected = [desktop];
      await notifications.service.connectDevice(desktop);
    },
    /** The app quits or loses its connection. */
    leave() {
      connected = [];
    },
  };
}
