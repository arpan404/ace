import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { notificationsRetained } from "@ace/notify";
import { Agent, AgentId, type DeviceId, type Notification } from "@ace/protocol";
import { createDaemonNotifications } from "./notifications.ts";
import {
  desktop,
  notificationFixture,
  subscription,
  browser,
} from "./notification-test-support.ts";
import { formatUuidV7 } from "./time-ordered-id.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** A daemon whose desktop is the only device, as the desktop app registers it. */
function desktopDaemon(f: ReturnType<typeof notificationFixture>, now?: () => number) {
  const received: Notification[] = [];
  let connected: DeviceId[] = [];
  const notifications = createDaemonNotifications(f.home, f.store, () => {}, {}, 0, {
    spawn: f.spawn,
    slept: !notificationsRetained(f.path),
    ...(now ? { now } : {}),
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
  };
}

test("a needs-you committed just before a crash is still delivered when the desktop returns much later", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  const before = desktopDaemon(f);
  await before.connect();
  // The daemon goes down without a deliberate stop, after the event commits and before the
  // worker reads it.
  await before.notifications.close();
  f.needsYou(thread);

  // A minute later, far past the window a sleeping worker would skip.
  const after = desktopDaemon(f, () => Date.now() + 60_000);
  cleanups.push(() => after.notifications.close());
  await after.connect();
  await vi.waitFor(() =>
    expect(after.received.map((alert) => [alert.threadId, alert.status])).toEqual([
      [thread, "needs_you"],
    ]),
  );
  await settle();
  expect(after.received).toHaveLength(1);
});

test("an agent notice queued before a crash is delivered after restart, however old", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  const agent = Agent.parse({
    id: "root",
    threadId: thread,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: f.home,
    status: { state: "idle" },
    createdAt: 1,
  });
  f.store.appendEvents(thread, [{ type: "agent.created", agent }]);
  const before = desktopDaemon(f);
  await before.connect();
  await before.notifications.close();
  const queued = Date.now() - 3_600_000;
  f.store.enqueueMcpIntent(
    formatUuidV7(queued, 0, randomBytes(8)),
    {
      type: "mcp.notify",
      sessionId: "session",
      threadId: thread,
      agentId: AgentId.parse("root"),
      notice: { text: "Build is green", level: "info" },
    },
    [],
    queued,
  );

  const after = desktopDaemon(f);
  cleanups.push(() => after.notifications.close());
  await after.connect();
  await vi.waitFor(() =>
    expect(after.received.map((alert) => [alert.status, alert.message])).toEqual([
      ["agent_says", "Build is green"],
    ]),
  );
});

test("a worker that crashes between replying and reporting its deadline still delivers", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  const pushed: Notification[] = [];
  let spawned = 0;
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
      // The first worker dies after acknowledging the needs-you; its replacement is real.
      spawn: (entry, options) =>
        spawned++ === 0
          ? new Worker(new URL("./notification-crash.test-helper.ts", import.meta.url), {
              ...options,
              workerData: { ...options?.workerData, entry: entry.href },
            })
          : f.spawn(entry, options),
    },
  );
  cleanups.push(() => notifications.close());
  notifications.activate();
  await notifications.service.register(browser, subscription);
  // Let the wake's own delivery run finish, so nothing is in flight when the worker dies.
  await settle();
  f.needsYou(thread);
  await vi.waitFor(() => expect(spawned).toBe(2));
  // Nothing else happens: no client, no events. The replacement's own report drives delivery.
  await vi.waitFor(() => expect(pushed.map((alert) => alert.status)).toEqual(["needs_you"]), {
    timeout: 4000,
  });
});
