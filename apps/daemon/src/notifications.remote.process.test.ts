import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { DeviceId, Notification, CommandId } from "@ace/protocol";
import { NotificationWorker, attachNotifications } from "@ace/notify";
import { setup, cleanups } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";
import { createDaemonNotifications } from "./notifications.ts";

it("paired notification access requires read scope and snooze and actions require operate scope", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-notification-scopes-"));
  const worker = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: {
      async send() {
        return "accepted";
      },
    },
  });
  cleanups.push(async () => {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  });
  const f = await setup({ notifications: worker });
  const attached = attachNotifications(worker, f.store, () => {});
  cleanups.push(async () => attached.close());
  await attached.tick();
  const reader = await f.pair(["read"]),
    operator = await f.pair(["operate"]);
  const read = await f.connectTicket(reader.device.id, (await f.ticket(reader.token)).ticket);
  const operate = await f.connectTicket(
    operator.device.id,
    (await f.ticket(operator.token)).ticket,
  );
  expect(await read.next()).toMatchObject({ type: "welcome" });
  expect(await operate.next()).toMatchObject({ type: "welcome" });
  read.send({ type: "notification.register", device: { channel: "websocket", platform: "phone" } });
  read.send({
    type: "notification.preferences",
    preferences: { includePreview: false, quietHours: null },
  });
  read.send({ type: "ping" });
  expect(await read.next()).toEqual({ type: "pong" });
  const notification = Notification.parse({
    id: "n",
    threadId: f.thread.id,
    status: "done",
    title: "Safe",
    actions: [],
    backgroundCount: 0,
  });
  expect(f.server.notify(reader.device.id, notification)).toBe(true);
  expect(await read.next()).toMatchObject({ type: "notification", notification });
  expect(f.server.notify(operator.device.id, notification)).toBe(false);
  operate.send({
    type: "notification.register",
    device: { channel: "websocket", platform: "phone" },
  });
  expect(await operate.next()).toMatchObject({ type: "error", code: "forbidden" });
  read.send({ type: "notification.snooze", threadId: f.thread.id, until: 10000 });
  expect(await read.next()).toMatchObject({ type: "error", code: "forbidden" });
  read.send({
    type: "command",
    command: {
      id: CommandId.parse("denied"),
      deviceId: reader.device.id,
      payload: { type: "thread.archive", threadId: f.thread.id },
    },
  });
  expect(await read.next()).toMatchObject({ type: "error", code: "forbidden" });
  operate.send({
    type: "command",
    command: {
      id: CommandId.parse("allowed"),
      deviceId: operator.device.id,
      payload: { type: "thread.archive", threadId: f.thread.id },
    },
  });
  expect(await operate.next()).toMatchObject({ type: "commandResult", ok: true });
  expect(f.store.getThread(f.thread.id)?.archivedAt).toBeDefined();
  await f.request(`/v1/devices/${reader.device.id}`, { method: "DELETE", token });
  await worker.cursor();
  expect(f.server.notify(reader.device.id, notification)).toBe(false);
  await expect(worker.connectDevice(reader.device.id)).rejects.toThrow();
});

it("persisted remote revocation suppresses an offline push after notifications restart", async () => {
  const f = await setup();
  const paired = await f.pair();
  const delivered: DeviceId[] = [],
    errors: unknown[] = [];
  const start = () =>
    createDaemonNotifications(
      f.home,
      f.store,
      (error) => errors.push(error),
      {
        apns: {
          async send(device) {
            delivered.push(device.id);
            return "accepted";
          },
        },
      },
      0,
    );
  const original = start();
  await original.service.register(paired.device.id, {
    channel: "apns",
    platform: "phone",
    token: "ab".repeat(32),
  });
  await original.close();
  await f.request(`/v1/devices/${paired.device.id}`, { method: "DELETE", token });
  f.store.appendEvents(
    f.thread.id,
    [{ type: "thread.updated", status: { state: "done" } }],
    Date.now() - 6000,
  );
  const restarted = start();
  cleanups.push(() => restarted.close());
  await restarted.start();
  expect(errors).toEqual([]);
  expect(await restarted.service.cursor()).toBe(f.store.headSeq());
  expect(delivered).toEqual([]);
  await expect(restarted.service.connectDevice(paired.device.id)).rejects.toThrow();
});
