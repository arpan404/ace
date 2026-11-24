import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceId,
  Event,
  ThreadId,
  type NotificationDevice,
  type Notification,
} from "@ace/protocol";
import { expect, it, vi } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { NotificationWorker, attachNotifications, notificationsRetained } from "./index.ts";

it("paged worker recovery waits for the current log before delivering a historical done status", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-worker-"));
  const deliveries: Notification[] = [];
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: {
      async send(_device, notification) {
        deliveries.push(notification);
        return "accepted";
      },
    },
  });
  const now = Date.now();
  const history = Array.from({ length: 5000 }, (_, index) =>
    Event.parse({
      seq: index + 1,
      id: `e${index}`,
      threadId: "thread",
      at: now,
      payload:
        index === 0
          ? {
              type: "thread.created",
              thread: {
                id: "thread",
                workspaceId: "w",
                provider: "codex",
                title: "Safe",
                status: { state: "new" },
                createdAt: now,
                updatedAt: now,
              },
            }
          : index === 1
            ? { type: "thread.updated", status: { state: "done" } }
            : index === 4999
              ? { type: "thread.updated", status: { state: "working", agents: 1 } }
              : {
                  type: "item.delta",
                  itemId: "item",
                  agentId: "agent",
                  field: "text",
                  append: "sensitive delta".repeat(100),
                },
    }),
  );
  const errors: unknown[] = [];
  const attached = attachNotifications(
    worker,
    {
      readEvents: ({ afterSeq, limit }) => history.slice(afterSeq, afterSeq + limit),
      subscribe: () => () => {},
    },
    (error) => errors.push(error),
  );
  try {
    await worker.register(DeviceId.parse("device"), { channel: "websocket", platform: "desktop" });
    await expect(worker.ingest(history)).rejects.toThrow("256");
    await attached.tick();
    expect(deliveries).toEqual([]);
    await attached.tick();
    expect(deliveries).toEqual([]);
    expect(await worker.cursor()).toBe(5000);
    expect(errors).toEqual([]);
  } finally {
    attached.close();
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("revocation aborts an in-flight worker delivery and prevents future sends", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-worker-abort-"));
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let sends = 0,
    aborted = 0;
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: {
      send(_device: NotificationDevice, _notification: Notification, signal: AbortSignal) {
        sends++;
        started?.();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted++;
              resolve("retry");
            },
            { once: true },
          );
        });
      },
    },
  });
  const device = DeviceId.parse("phone"),
    now = Date.now();
  const initial = Event.parse({
    seq: 1,
    id: "e1",
    threadId: "t",
    at: now,
    payload: {
      type: "thread.created",
      thread: {
        id: "t",
        workspaceId: "w",
        provider: "codex",
        title: "Safe",
        status: { state: "new" },
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const done = Event.parse({
    seq: 2,
    id: "e2",
    threadId: "t",
    at: now,
    payload: { type: "thread.updated", status: { state: "done" } },
  });
  try {
    await worker.register(device, { channel: "websocket", platform: "phone" });
    await worker.ingest([initial, done]);
    const drained = worker.drain();
    await ready;
    await worker.revoke(device);
    await drained;
    expect(aborted).toBe(1);
    await worker.drain();
    expect(sends).toBe(1);
    await expect(worker.connectDevice(device)).rejects.toThrow("rejected");
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("closes gracefully with all 64 RPC slots occupied and settles admitted calls", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-close-"));
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    const pending = Array.from({ length: 64 }, () => worker.cursor());
    const results = Promise.allSettled(pending);
    await expect(worker.close()).resolves.toBeUndefined();
    expect(await results).toEqual(
      Array.from({ length: 64 }, () => ({ status: "fulfilled", value: 0 })),
    );
    await expect(worker.cursor()).rejects.toThrow();
  } finally {
    await worker.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

it("bounds cleanup admission independently of ordinary calls and recovers after acknowledgement", async () => {
  const worker = new NotificationWorker({
    path: ":memory:",
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    const ordinary = Array.from({ length: 64 }, () => worker.cursor());
    const removals = Array.from({ length: 256 }, (_, i) => worker.disconnect(`session-${i}`));
    const settled = Promise.allSettled([...ordinary, ...removals]);
    await expect(worker.disconnect("overflow")).rejects.toThrow("cleanup backpressure");
    expect((await settled).every((result) => result.status === "fulfilled")).toBe(true);
    await expect(worker.disconnect("after-drain")).resolves.toBeUndefined();
    await expect(worker.close()).resolves.toBeUndefined();
  } finally {
    await worker.close();
  }
});

it("a crashed notification worker restarts with backoff and resumes durable delivery", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-restart-"));
  const restart = Promise.withResolvers<() => void>();
  const restarted = Promise.withResolvers<void>();
  let owned: Worker | undefined;
  let spawns = 0;
  const delivered: Notification[] = [];
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    spawn(entry, options) {
      owned = new Worker(entry, options);
      if (++spawns === 2) restarted.resolve();
      return owned;
    },
    schedule(delay, run) {
      expect(delay).toBe(250);
      restart.resolve(run);
      return () => {};
    },
    transport: {
      async send(_device, notification) {
        delivered.push(notification);
        return "accepted";
      },
    },
  });
  const now = Date.now();
  try {
    await worker.connectDevice(DeviceId.parse("device"));
    await worker.ingest([
      Event.parse({
        seq: 1,
        id: "e1",
        threadId: "t",
        at: now,
        payload: {
          type: "thread.created",
          thread: {
            id: "t",
            workspaceId: "w",
            provider: "codex",
            title: "Recovered",
            status: { state: "new" },
            createdAt: now,
            updatedAt: now,
          },
        },
      }),
      Event.parse({
        seq: 2,
        id: "e2",
        threadId: "t",
        at: now,
        payload: { type: "thread.updated", status: { state: "done" } },
      }),
    ]);
    if (!owned) throw new Error("Worker not spawned");
    await owned.terminate();
    const resume = await restart.promise;
    await expect(worker.cursor()).rejects.toThrow("exited");
    resume();
    await restarted.promise;
    expect(await worker.cursor()).toBe(2);
    await worker.drain();
    expect(delivered).toMatchObject([{ threadId: "t", status: "done" }]);
    await expect(worker.disconnect("recovered-session")).resolves.toBeUndefined();
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps working when Node tooling posts its own records on the worker channel", async () => {
  // `node --watch` makes every worker post `{ "watch:import": [...] }` to its parent.
  const worker = new NotificationWorker({
    path: ":memory:",
    spawn(entry, options) {
      const spawned = new Worker(entry, options);
      spawned.once("online", () => spawned.emit("message", { "watch:import": [entry.href] }));
      return spawned;
    },
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    await expect(worker.cursor()).resolves.toBe(0);
  } finally {
    await worker.close();
  }
});

it("a notification worker from another build refuses to start, so no frame in another shape is taken", async () => {
  const worker = new NotificationWorker({
    path: ":memory:",
    // What a daemon of another build sends: its own channel shape.
    spawn: (entry, options) =>
      new Worker(entry, { ...options, workerData: { ...options.workerData, shape: "other" } }),
    schedule: () => () => {},
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    await expect(worker.cursor()).rejects.toThrow();
  } finally {
    await worker.close().catch(() => {});
  }
});

it("arguments the daemon was handed are bounded before they reach the worker", async () => {
  const worker = new NotificationWorker({
    path: ":memory:",
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    const long = DeviceId.parse("d".repeat(201));
    await expect(worker.connectDevice(long)).rejects.toThrow();
    await expect(worker.disconnect("s".repeat(201))).rejects.toThrow();
    await expect(
      worker.markRemote(Array.from({ length: 257 }, (_, i) => ThreadId.parse(`t${i}`))),
    ).rejects.toThrow();
    await expect(worker.snooze(ThreadId.parse("thread"), -1)).rejects.toThrow();
    // The worker is still answering: only the out-of-bounds calls were refused.
    await expect(worker.cursor()).resolves.toBe(0);
    await expect(worker.connectDevice(DeviceId.parse("device"))).resolves.toBeUndefined();
  } finally {
    await worker.close();
  }
});

it("a stretch of streamed deltas reaches the worker as one cursor advance, and the done status after it still alerts", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-hold-"));
  const delivered: Notification[] = [];
  const ingests: unknown[] = [];
  const holds: (() => void)[] = [];
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    spawn(entry, options) {
      const spawned = new Worker(entry, options);
      // What crosses to the worker is the cost under test: each ingest is a round trip.
      const post = spawned.postMessage.bind(spawned);
      spawned.postMessage = (message: unknown, transfer?: never) => {
        const call = Reflect.get(Object(message), "call");
        if (Reflect.get(Object(call), "method") === "ingest") ingests.push(call);
        post(message, transfer);
      };
      return spawned;
    },
    holdTimer(_delay, release) {
      const fire = () => {
        holds.splice(holds.indexOf(fire), 1);
        release();
      };
      holds.push(fire);
      return () => holds.splice(holds.indexOf(fire), 1);
    },
    transport: {
      async send(_device, notification) {
        delivered.push(notification);
        return "accepted";
      },
    },
  });
  const now = Date.now();
  const event = (seq: number, payload: unknown) =>
    Event.parse({ seq, id: `e${seq}`, threadId: "t", at: now, payload });
  const delta = (seq: number) =>
    event(seq, { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "x" });
  try {
    await worker.connectDevice(DeviceId.parse("device"));
    const thread = {
      id: "t",
      workspaceId: "w",
      provider: "codex",
      title: "Streaming",
      status: { state: "working", agents: 1 },
      createdAt: now,
      updatedAt: now,
    };
    await worker.ingest([event(1, { type: "thread.created", thread })]);
    ingests.length = 0;
    // Live batches, one delta each, as the store publishes them.
    for (let seq = 2; seq <= 101; seq++) await worker.ingest([delta(seq)]);
    expect(ingests).toEqual([]);
    // The hold ends on its timer: the whole stretch is one advance.
    holds[0]?.();
    expect(await worker.cursor()).toBe(101);
    expect(ingests).toEqual([{ method: "ingest", afterSeq: 1, throughSeq: 101, events: [] }]);
    // A notice joins the stretch held before it, and alerts as soon as it arrives.
    ingests.length = 0;
    for (let seq = 102; seq <= 120; seq++) await worker.ingest([delta(seq)]);
    await worker.ingest([event(121, { type: "thread.updated", status: { state: "done" } })]);
    expect(ingests).toMatchObject([{ afterSeq: 101, throughSeq: 121 }]);
    expect(holds).toEqual([]);
    await worker.drain();
    expect(delivered).toMatchObject([{ threadId: "t", status: "done" }]);
    // A held stretch is never lost: reading the cursor sends it first.
    for (let seq = 122; seq <= 130; seq++) await worker.ingest([delta(seq)]);
    expect(await worker.cursor()).toBe(130);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

const liveActivity = (startToken?: string, activityToken?: string) => ({
  startToken,
  activityToken,
  environment: "sandbox" as const,
  frequentUpdates: true,
  slot: 3,
});

it("a phone's live activity tokens survive a worker restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-"));
  const path = join(home, "notify.sqlite");
  const startToken = "a1".repeat(32),
    activityToken = "b2".repeat(32);
  const phone = DeviceId.parse("phone");
  let worker = new NotificationWorker({
    path,
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    await worker.register(phone, { channel: "websocket", platform: "phone" });
    await worker.syncLiveActivity(phone, [], liveActivity(startToken, activityToken));
    const stored = [
      {
        token: startToken,
        environment: "sandbox",
        kind: "start",
        frequentUpdates: true,
        slot: 3,
        devices: [phone],
      },
      {
        token: activityToken,
        environment: "sandbox",
        kind: "liveactivity",
        frequentUpdates: true,
        slot: 3,
        devices: [phone],
      },
    ];
    expect(await worker.liveActivityTargets()).toEqual(stored);
    await worker.close();
    worker = new NotificationWorker({
      path,
      transport: {
        async send() {
          return "accepted";
        },
      },
    });
    expect(await worker.liveActivityTargets()).toEqual(stored);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("a sync replaces the tokens it names and clears the kinds it leaves out", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-sync-"));
  const phone = DeviceId.parse("phone");
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  try {
    await worker.register(phone, { channel: "websocket", platform: "phone" });
    const first = "11".repeat(32),
      second = "22".repeat(32),
      rotated = "33".repeat(32);
    await worker.syncLiveActivity(phone, [], liveActivity(first, second));
    expect((await worker.liveActivityTargets()).map((target) => target.kind)).toEqual([
      "start",
      "liveactivity",
    ]);
    // The activity ended on the phone: only its update token goes, the start token stays.
    await worker.syncLiveActivity(phone, [], { ...liveActivity(first), slot: 4 });
    expect(await worker.liveActivityTargets()).toEqual([
      {
        token: first,
        environment: "sandbox",
        kind: "start",
        frequentUpdates: true,
        slot: 4,
        devices: [phone],
      },
    ]);
    // The object is gone: both tokens go.
    await worker.syncLiveActivity(phone, [], undefined);
    expect(await worker.liveActivityTargets()).toEqual([]);
    // A rotated token replaces the old one rather than joining it.
    await worker.syncLiveActivity(phone, [], liveActivity(first, second));
    await worker.syncLiveActivity(phone, [], liveActivity(first, rotated));
    expect((await worker.liveActivityTargets()).map((target) => target.token)).toEqual([
      first,
      rotated,
    ]);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("one install over two linked ids keeps each token once, and either id leaving clears them", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-linked-"));
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  const direct = DeviceId.parse("direct"),
    relay = DeviceId.parse("relay");
  const startToken = "AA".repeat(32),
    activityToken = "BB".repeat(32);
  try {
    await worker.register(direct, { channel: "websocket", platform: "phone" });
    await worker.register(relay, { channel: "websocket", platform: "phone" });
    // The same phone sends the same tokens over both of its routes, in either case.
    await worker.syncLiveActivity(direct, [relay], liveActivity(startToken, activityToken));
    await worker.syncLiveActivity(
      relay,
      [direct],
      liveActivity(startToken.toLowerCase(), activityToken.toLowerCase()),
    );
    expect((await worker.liveActivityTargets()).map((target) => target.token)).toEqual([
      startToken.toLowerCase(),
      activityToken.toLowerCase(),
    ]);
    // Each target names the whole association, so the daemon can check current pairing authority.
    expect((await worker.liveActivityTargets()).map((target) => target.devices.toSorted())).toEqual(
      [
        ["direct", "relay"],
        ["direct", "relay"],
      ],
    );
    await worker.unregister(relay);
    expect(await worker.liveActivityTargets()).toEqual([]);
    await worker.syncLiveActivity(direct, [relay], liveActivity(startToken, activityToken));
    expect(await worker.liveActivityTargets()).toHaveLength(2);
    await worker.revoke(direct);
    expect(await worker.liveActivityTargets()).toEqual([]);
    // A revoked id is a tombstone: the other route cannot restore what it held.
    await expect(
      worker.syncLiveActivity(direct, [relay], liveActivity(startToken, activityToken)),
    ).rejects.toThrow("revoked");
    expect(await worker.liveActivityTargets()).toEqual([]);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("a token the push service reports gone is dropped only while it is still the stored one", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-gone-"));
  const phone = DeviceId.parse("phone");
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  const stale = "cc".repeat(32),
    current = "dd".repeat(32);
  try {
    await worker.register(phone, { channel: "websocket", platform: "phone" });
    await worker.syncLiveActivity(phone, [], liveActivity(undefined, stale));
    await worker.syncLiveActivity(phone, [], liveActivity(undefined, current));
    // The gateway only now reports the old token: the rotated one must stay.
    await worker.dropLiveActivityToken({
      token: stale,
      environment: "sandbox",
      kind: "liveactivity",
    });
    expect((await worker.liveActivityTargets()).map((target) => target.token)).toEqual([current]);
    await worker.dropLiveActivityToken({
      token: current,
      environment: "production",
      kind: "liveactivity",
    });
    expect((await worker.liveActivityTargets()).map((target) => target.token)).toEqual([current]);
    await worker.dropLiveActivityToken({
      token: current,
      environment: "sandbox",
      kind: "liveactivity",
    });
    expect(await worker.liveActivityTargets()).toEqual([]);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("evicting a stale device clears the live activity tokens it registered", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-capacity-"));
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  const oldest = "aa".repeat(32);
  try {
    for (let index = 0; index < 128; index++)
      await worker.register(DeviceId.parse(`device-${index}`), {
        channel: "websocket",
        platform: "web",
      });
    await worker.syncLiveActivity(DeviceId.parse("device-0"), [], liveActivity(oldest));
    expect((await worker.liveActivityTargets()).map((target) => target.token)).toEqual([oldest]);
    await worker.register(DeviceId.parse("device-128"), {
      channel: "websocket",
      platform: "web",
    });
    expect(await worker.liveActivityTargets()).toEqual([]);
    await expect(
      worker.syncLiveActivity(DeviceId.parse("device-0"), [], liveActivity(oldest)),
    ).rejects.toThrow("unavailable");
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("live activity tokens keep the worker awake, and a store from before them stays asleep", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-retained-"));
  const path = join(home, "notify.sqlite");
  const device = DeviceId.parse("desktop"),
    token = "ee".repeat(32);
  const states: { idle: boolean }[] = [];
  const transport = {
    async send() {
      return "accepted" as const;
    },
  };
  let worker = new NotificationWorker({
    path,
    onState: (state) => states.push(state),
    transport,
  });
  try {
    await worker.register(device, { channel: "websocket", platform: "desktop" });
    await worker.syncLiveActivity(device, [], liveActivity(undefined, token));
    await vi.waitFor(() => expect(states.at(-1)?.idle).toBe(false));
    await worker.close();
    // A stopped daemon still has a token to register, so it wakes its worker from startup.
    expect(notificationsRetained(path)).toBe(true);
    worker = new NotificationWorker({ path, transport });
    await worker.clearLiveActivity();
    await worker.close();
    expect(notificationsRetained(path)).toBe(false);
    // A store from before this table keeps nothing there: it stays asleep instead of waking.
    worker = new NotificationWorker({ path, transport });
    await worker.syncLiveActivity(device, [], liveActivity(undefined, token));
    await worker.close();
    expect(notificationsRetained(path)).toBe(true);
    const older = new DatabaseSync(path);
    older.exec("DROP TABLE live_activity");
    older.close();
    expect(notificationsRetained(path)).toBe(false);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("an expired alert address does not take the live activity tokens with it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-live-activity-expired-"));
  const phone = DeviceId.parse("phone");
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: {
      async send() {
        return "gone";
      },
    },
  });
  const token = "ff".repeat(32);
  const now = Date.now();
  const event = (seq: number, payload: unknown) =>
    Event.parse({ seq, id: `e${seq}`, threadId: "t", at: now, payload });
  try {
    await worker.register(phone, {
      channel: "push",
      platform: "phone",
      token: "ab".repeat(32),
      environment: "sandbox",
      p256dh: "A".repeat(87),
      auth: "A".repeat(22),
    });
    await worker.syncLiveActivity(phone, [], liveActivity(undefined, token));
    await worker.ingest([
      event(1, {
        type: "thread.created",
        thread: {
          id: "t",
          workspaceId: "w",
          provider: "codex",
          title: "Gone",
          status: { state: "new" },
          createdAt: now,
          updatedAt: now,
        },
      }),
      event(2, { type: "thread.updated", status: { state: "done" } }),
    ]);
    await worker.drain();
    // The push service said the alert address is gone; the Live Activity token is another edge.
    expect((await worker.liveActivityTargets()).map((entry) => entry.token)).toEqual([token]);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
