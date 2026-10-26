import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { Agent, AgentId, type Notification } from "@ace/protocol";
import { createDaemonNotifications } from "./notifications.ts";
import {
  desktopDaemon,
  notificationFixture,
  subscription,
  browser,
} from "./notification-test-support.ts";
import { formatUuidV7 } from "./time-ordered-id.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const CloseSleep = z.object({
  type: z.literal("call"),
  id: z.number(),
  call: z.object({ method: z.literal("closeSleep") }),
});
const Reply = z.object({ type: z.literal("result"), id: z.number() });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("a needs-you committed just before a crash is still delivered when the desktop returns much later", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  const before = desktopDaemon(f);
  await before.connect();
  // The daemon goes down without a deliberate stop, after the event commits and before the
  // worker reads it.
  await before.notifications.close();
  // Committed a minute before the desktop returns: far past the window a sleeping worker skips.
  f.needsYou(thread, Date.now() - 60_000);

  const after = desktopDaemon(f);
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
              workerData: { ...options?.workerData, entry: entry.href, crash: "needs-you-reply" },
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

test("a worker that dies before its first reply is replaced, and the new one serves calls and recovers", async () => {
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
      spawn: (entry, options) =>
        spawned++ === 0
          ? new Worker(new URL("./notification-crash.test-helper.ts", import.meta.url), {
              ...options,
              workerData: { ...options?.workerData, entry: entry.href, crash: "first-call" },
            })
          : f.spawn(entry, options),
    },
  );
  cleanups.push(() => notifications.close());
  notifications.activate();
  // The first call meets the dying worker; later ones reach its replacement.
  await notifications.service.register(browser, subscription).catch(() => {});
  await vi.waitFor(() => notifications.service.register(browser, subscription), {
    timeout: 4000,
  });
  expect(spawned).toBe(2);
  expect(await notifications.service.cursor()).toBe(f.store.headSeq());
  f.needsYou(thread);
  await vi.waitFor(() => expect(pushed.map((alert) => alert.status)).toEqual(["needs_you"]));
});

test("an update made during a sleep keeps an alert raised before the crash", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  const before = desktopDaemon(f);
  await before.connect();
  await before.notifications.close();
  // The thread finishes; the daemon goes down before the worker reads it.
  f.store.appendEvents(
    thread,
    [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "done" } },
    ],
    Date.now() - 120_000,
  );
  // The daemon comes back with no worker; while it sleeps the thread is renamed.
  const after = desktopDaemon(f);
  cleanups.push(() => after.notifications.close());
  f.store.appendEvents(thread, [{ type: "thread.updated", title: "Renamed" }], Date.now() - 60_000);

  await after.connect();
  await vi.waitFor(() =>
    expect(after.received.map((alert) => [alert.status, alert.title])).toEqual([
      ["done", "Renamed"],
    ]),
  );
});

test("agent notices from a sleep stay unsent when the daemon stops right after waking", async () => {
  const f = notificationFixture(cleanups);
  const thread = f.thread();
  f.store.appendEvents(thread, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: f.home,
        status: { state: "idle" },
        createdAt: 1,
      }),
    },
  ]);
  // The daemon goes down as soon as its woken worker has closed the sleep window.
  let stopAfterWake: (() => void) | undefined;
  const watching: typeof f.spawn = (entry, options) => {
    const worker = f.spawn(entry, options);
    const post = worker.postMessage.bind(worker);
    const closing = new Set<number>();
    Reflect.set(worker, "postMessage", (message: unknown) => {
      const call = CloseSleep.safeParse(message);
      if (call.success) closing.add(call.data.id);
      post(message, []);
    });
    worker.on("message", (input: unknown) => {
      const reply = Reply.safeParse(input);
      if (reply.success && closing.has(reply.data.id)) stopAfterWake?.();
    });
    return worker;
  };
  let offset = 0;
  const first = desktopDaemon(f, {
    quietMs: 20,
    now: () => Date.now() + offset,
    spawn: watching,
  });
  await first.connect();
  first.leave();
  await vi.waitFor(() => expect(f.exited).toHaveLength(1));
  // While the worker sleeps an agent says something; the desktop returns an hour later.
  const queued = Date.now();
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
  offset = 3_600_000;
  stopAfterWake = () => first.notifications.stop();
  await first.connect().catch(() => {});
  await first.notifications.close();

  const second = desktopDaemon(f);
  cleanups.push(() => second.notifications.close());
  await second.connect();
  await settle();
  expect(second.received.filter((alert) => alert.status === "agent_says")).toEqual([]);
  expect(f.store.readMcpIntents(64, "mcp.notify")).toEqual([]);
});
