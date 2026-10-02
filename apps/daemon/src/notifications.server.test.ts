import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DeviceId, Command, InteractionId, AgentId, type Notification } from "@ace/protocol";
import { NotificationWorker, attachNotifications, createNotificationRouter } from "@ace/notify";
import { afterEach, expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const offline = () => false;
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-sockets-"));
  let sender: (device: DeviceId, notification: Notification) => boolean = offline;
  const mobile: string[] = [];
  const service = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: createNotificationRouter({
      websocket: (id, notification) => sender(id, notification),
      apns: {
        async send(device) {
          mobile.push(device.id);
          return "accepted";
        },
      },
    }),
  });
  const f = await fixture({
    notifications: service,
    handler: {
      handle(command, store) {
        const p = command.payload;
        if (p.type !== "interaction.resolve") return { commandId: command.id, ok: false };
        const events = store.readEvents({ afterSeq: 0, limit: 100 });
        const pending = events.find(
          (event) =>
            event.payload.type === "interaction.opened" &&
            event.payload.interaction.id === p.interactionId,
        );
        if (
          !pending ||
          events.some(
            (event) =>
              event.payload.type === "interaction.closed" &&
              event.payload.interactionId === p.interactionId,
          )
        )
          return { commandId: command.id, ok: false, error: "already_resolved" };
        store.appendEvents(pending.threadId, [
          {
            type: "interaction.closed",
            interactionId: p.interactionId,
            state: "resolved",
            resolution: p.resolution,
            resolvedBy: command.deviceId,
            closedAt: 2,
          },
        ]);
        return { commandId: command.id, ok: true };
      },
    },
  });
  sender = f.server.notify;
  const errors: unknown[] = [];
  const attached = attachNotifications(service, f.store, (error) => errors.push(error));
  await attached.tick();
  cleanups.push(async () => {
    attached.close();
    await f.close();
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  const desktop = DeviceId.parse("device"),
    phone = DeviceId.parse("phone");
  await service.register(phone, { channel: "apns", platform: "phone", token: "ab".repeat(32) });
  return { f, service, attached, client, desktop, phone, mobile, errors };
}

it("authenticated websocket presence suppresses phone push and delivers browser notification", async () => {
  const { f, client, service, attached, mobile, errors } = await setup();
  client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
    { type: "thread.updated", status: { state: "done" } },
  ]);
  await attached.tick();
  expect(await client.next()).toMatchObject({
    type: "notification",
    notification: { threadId: f.thread.id, title: f.thread.title, status: "done" },
  });
  expect(mobile).toEqual([]);
  await client.close();
  // The close handshake guarantees cleanup precedes the worker barrier.
  await service.cursor();
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
    { type: "thread.updated", status: { state: "failed" } },
  ]);
  await attached.tick();
  expect(mobile).toEqual(["phone"]);
  expect(errors).toEqual([]);
});
it("notification approve and deny actions require authenticated identity and retain first-answer-wins receipts", async () => {
  const { f, client, attached, errors } = await setup();
  const interactionId = InteractionId.parse("approval");
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
    {
      type: "interaction.opened",
      interaction: {
        id: interactionId,
        threadId: f.thread.id,
        agentId: AgentId.parse("root"),
        blocking: true,
        state: "pending",
        request: {
          kind: "approval",
          title: "private",
          options: [
            { id: "yes", label: "Allow", kind: "allow_once" },
            { id: "no", label: "Deny", kind: "deny" },
          ],
        },
        createdAt: 1,
        raw: [],
      },
    },
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  await attached.tick();
  const message = await client.next();
  expect(message).toMatchObject({
    type: "notification",
    notification: {
      interactionId,
      actions: [
        { action: "approve", optionId: "yes" },
        { action: "deny", optionId: "no" },
      ],
    },
  });
  const forged = Command.parse({
    id: "forged",
    deviceId: "phone",
    payload: {
      type: "interaction.resolve",
      interactionId,
      resolution: { kind: "approval", optionId: "yes" },
    },
  });
  client.send({ type: "command", command: forged });
  expect(await client.next()).toMatchObject({ type: "error", code: "device_mismatch" });
  const command = Command.parse({ ...forged, id: "approve", deviceId: "device" });
  client.send({ type: "command", command });
  expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
  client.send({ type: "command", command });
  expect(await client.next()).toEqual({ type: "commandResult", commandId: command.id, ok: true });
  client.send({
    type: "command",
    command: Command.parse({
      ...command,
      id: "deny",
      payload: {
        type: "interaction.resolve",
        interactionId,
        resolution: { kind: "approval", optionId: "no" },
      },
    }),
  });
  expect(await client.next()).toMatchObject({
    type: "commandResult",
    ok: false,
    error: "already_resolved",
  });
  const resolutions = f.store
    .readEvents({ afterSeq: 0, limit: 100 })
    .filter((event) => event.payload.type === "interaction.closed");
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]?.payload).toMatchObject({
    resolvedBy: "device",
    resolution: { kind: "approval", optionId: "yes" },
  });
  expect(errors).toEqual([]);
});
it("registration and preferences are bound to the connection and revoked clients cannot reconnect", async () => {
  const { client, service, f, desktop, mobile, attached } = await setup();
  client.send({
    type: "notification.register",
    device: { channel: "websocket", platform: "desktop" },
  });
  client.send({
    type: "notification.preferences",
    preferences: {
      includePreview: false,
      quietHours: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
    },
  });
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
  await attached.tick();
  client.send({ type: "ping" });
  expect(await client.next()).toEqual({ type: "pong" });
  expect(mobile).toEqual(["phone"]);
  await service.revoke(desktop);
  await client.close();
  const again = await f.connect();
  const closed = once(again.socket, "close");
  expect(await again.next()).toMatchObject({ type: "error", code: "device_unavailable" });
  await closed;
  const unauthorized = await f.open();
  const unauthorizedClosed = once(unauthorized.socket, "close");
  unauthorized.socket.send(
    JSON.stringify({
      type: "notification.register",
      device: { channel: "websocket", platform: "phone" },
    }),
  );
  expect(await unauthorized.next()).toMatchObject({ type: "error", code: "unauthorized" });
  await unauthorizedClosed;
});
