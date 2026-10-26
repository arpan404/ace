import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { NotificationWorker, notificationsRetained } from "@ace/notify";
import { DeviceId, type Notification, type ThreadId } from "@ace/protocol";
import { prepareDaemonHome } from "@ace/service";
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

/**
 * Saves a paired browser's push subscription in `home`'s notification store, as a past run
 * would, so the next daemon there needs its notification worker from startup.
 */
export async function retainNotifications(home: string): Promise<void> {
  // State in a home without this build's format marker would be set aside as a legacy home.
  prepareDaemonHome(home);
  const path = join(home, "notifications.sqlite");
  const worker = new NotificationWorker({ path, transport: { send: async () => "failed" } });
  try {
    await worker.register(browser, subscription);
  } finally {
    await worker.close();
  }
  if (!notificationsRetained(path)) throw new Error("Notification state was not retained");
}

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
    /** Archives the thread, or brings it back. */
    archive: (thread: ThreadId, archived: boolean) =>
      store.appendEvents(thread, [
        { type: "thread.updated", archivedAt: archived ? Date.now() : null },
      ]),
    thread: () => createDevThread(store, workspace).id,
    path: join(home, "notifications.sqlite"),
  };
}

/** A daemon whose desktop is the only device, as the desktop app registers it. */
export function desktopDaemon(
  f: ReturnType<typeof notificationFixture>,
  options: {
    now?: () => number;
    quietMs?: number;
    spawn?: ReturnType<typeof notificationFixture>["spawn"];
  } = {},
) {
  const received: Notification[] = [];
  let connected: DeviceId[] = [];
  let holding = false;
  let refused = 0;
  const notifications = createDaemonNotifications(f.home, f.store, () => {}, {}, 0, {
    spawn: f.spawn,
    slept: !notificationsRetained(f.path),
    ...options,
  });
  notifications.setSender((device, notification) => {
    if (!connected.includes(device)) return false;
    if (holding) {
      refused++;
      return false;
    }
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
    /** Sends to the open socket fail until `release`, so the alert is retried. */
    hold() {
      holding = true;
    },
    release() {
      holding = false;
    },
    /** Sends that failed while held. */
    refused: () => refused,
  };
}
