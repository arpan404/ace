import { createDevThread } from "./commands.ts";
import { DeviceId, ThreadId, type Notification } from "@ace/protocol";
import { NotificationWorker } from "@ace/notify";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";

it("removes registered presence under unrelated RPC pressure and restores alerts and admission", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivered: Notification[] = [];
  const f = await fixture();
  const unrelated = createDevThread(f.store, f.workspace);
  const phone = DeviceId.parse("phone");
  const worker = new NotificationWorker({
    path: join(f.home, "pressure-notify.sqlite"),
    windowMs: 0,
    transport: {
      async send(device, notification) {
        if (device.id === phone && notification.threadId === unrelated.id) {
          started?.();
          await gate;
        }
        if (device.id === phone) delivered.push(notification);
        return "accepted";
      },
    },
  });
  // Use another real server with this worker as its notification boundary.
  const server = await fixture({ notifications: worker });
  const pending: Promise<void>[] = [];
  try {
    await worker.register(phone, { channel: "websocket", platform: "phone" });
    const client = await server.connect();
    await client.next();
    client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    f.store.appendEvents(unrelated.id, [{ type: "thread.updated", status: { state: "done" } }]);
    await worker.ingest(f.store.readEvents({ afterSeq: 0, limit: 256 }));
    pending.push(worker.drain());
    await ready;
    // These ordinary calls remain pending on the unrelated transport gate.
    for (let i = 1; i < 64; i++) pending.push(worker.drain());
    const settled = Promise.allSettled(pending);
    await expect(server.server.close()).resolves.toBeUndefined();
    release?.();
    expect((await settled).every((result) => result.status === "fulfilled")).toBe(true);
    const head = f.store.headSeq();
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
    await worker.ingest(f.store.readEvents({ afterSeq: head, limit: 256 }));
    await worker.drain();
    expect(delivered.some((notification) => notification.threadId === f.thread.id)).toBe(true);
    // All 256 presence slots must be free, including the disconnected viewer's slot.
    for (let i = 0; i < 256; i++)
      await worker.updatePresence(`replacement-${i}`, phone, {
        type: "presence.update",
        threadId: ThreadId.parse("other"),
        inputAgeMs: 0,
      });
  } finally {
    release?.();
    await Promise.allSettled(pending);
    await server.close().catch(() => {});
    await worker.close();
    await f.close();
  }
});
