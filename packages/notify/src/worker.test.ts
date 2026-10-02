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
