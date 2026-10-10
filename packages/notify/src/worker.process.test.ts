import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceId, Event, type NotificationDevice, type Notification } from "@ace/protocol";
import { expect, it } from "vitest";
import { NotificationWorker, attachNotifications } from "./index.ts";

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
