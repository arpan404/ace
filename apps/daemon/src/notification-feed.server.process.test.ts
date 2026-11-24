import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingLinkProof } from "@ace/client/link-proof";
import { DeviceId, SocketTicket, type Notification } from "@ace/protocol";
import { NotificationWorker, attachNotifications, createNotificationRouter } from "@ace/notify";
import { afterEach, expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const noSender = (): boolean => false;

/** A real daemon socket and notification worker on temp SQLite; the client is an iPhone app. */
async function phone() {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-feed-"));
  let sender: (device: DeviceId, notification: Notification) => boolean = noSender;
  const service = new NotificationWorker({
    path: join(home, "notify.sqlite"),
    windowMs: 0,
    transport: createNotificationRouter({ websocket: (id, value) => sender(id, value) }),
  });
  const f = await fixture({ notifications: service });
  sender = f.server.notify;
  const attached = attachNotifications(service, f.store, () => {});
  await attached.tick();
  cleanups.push(async () => {
    await attached.close();
    await f.close();
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  client.send({
    type: "notification.register",
    requestId: "register",
    device: { channel: "websocket", platform: "phone" },
  });
  expect(await client.next()).toEqual({
    type: "notification.register.result",
    requestId: "register",
  });
  const settle = async () => {
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  };
  const presence = async (appState: "foreground" | "background") => {
    client.send({ type: "presence.update", threadId: null, inputAgeMs: 0, appState });
    await settle();
  };
  const feed = async (afterCursor: number) => {
    client.send({ type: "notification.feed", requestId: `feed-${afterCursor}`, afterCursor });
    const reply = await client.next();
    if (reply.type !== "notification.feed.result") throw new Error(`Unexpected ${reply.type}`);
    return reply;
  };
  const status = async (state: "done" | "failed") => {
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state } },
    ]);
    await attached.tick();
  };
  return { f, client, attached, settle, presence, feed, status };
}

it("a backgrounded phone gets no live frame and catches up on the alert once it returns", async () => {
  const { client, settle, presence, feed, status } = await phone();
  await presence("background");
  await status("done");
  // The socket stays open but the app is suspended: no notification frame is sent to it.
  await settle();
  await presence("foreground");
  const missed = await feed(0);
  expect(missed.entries.map((entry) => entry.notification.status)).toEqual(["done"]);
  expect(missed.retracted).toEqual([]);
  // Catch-up from the stored cursor offers nothing twice.
  expect((await feed(missed.cursor)).entries).toEqual([]);
  // A foreground phone receives the next alert live, and the feed holds the same stable id.
  await status("failed");
  const live = await client.next();
  expect(live).toMatchObject({ type: "notification", notification: { status: "failed" } });
  const after = await feed(missed.cursor);
  expect(after.entries.map((entry) => entry.notification.id)).toEqual([
    live.type === "notification" ? live.notification.id : "",
  ]);
});

it("a phone that reconnects after the thread went back to work is told to withdraw the done alert", async () => {
  const { f, attached, presence, feed, status } = await phone();
  await presence("background");
  await status("done");
  const shown = (await feed(0)).entries[0]?.notification.id;
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  await attached.tick();
  const later = await feed(0);
  expect(later.entries).toEqual([]);
  expect(later.retracted).toEqual([shown]);
});

it("a phone that turns notifications off gets no alerts or catch-up entries until it registers again", async () => {
  const { client, settle, feed, status } = await phone();
  client.send({ type: "notification.unregister", requestId: "mute" });
  expect(await client.next()).toEqual({
    type: "notification.unregister.result",
    requestId: "mute",
  });
  await status("done");
  // The pong arrives after any notification frame the tick sent; none comes first.
  await settle();
  expect((await feed(0)).entries).toEqual([]);
  client.send({
    type: "notification.register",
    requestId: "unmute",
    device: { channel: "websocket", platform: "phone" },
  });
  expect(await client.next()).toEqual({
    type: "notification.register.result",
    requestId: "unmute",
  });
  await status("failed");
  expect(await client.next()).toMatchObject({
    type: "notification",
    notification: { status: "failed" },
  });
  expect((await feed(0)).entries.map((entry) => entry.notification.status)).toEqual(["failed"]);
});

it("a phone's other id reads the alert recorded for the id it registered, once, from its own cursor", async () => {
  const { f, presence, status } = await phone();
  const account = DeviceId.parse("account-phone");
  // One install paired twice, both proven by its account device (ADR 0115): two ids, one phone.
  const lan = f.store.devices.create("Phone (LAN)", ["read", "operate"], Date.now());
  const tunnel = f.store.devices.create("Phone (tunnel)", ["read", "operate"], Date.now());
  for (const pairing of [lan, tunnel])
    f.store.devices.link(
      account,
      await pairingLinkProof(pairing.token, pairing.device.id, account, crypto.subtle),
      Date.now(),
    );
  const open = async (pairing: typeof lan) => {
    const response = await fetch(f.server.url.replace("ws:", "http:") + "/v1/tickets", {
      method: "POST",
      headers: { Authorization: `Bearer ${pairing.token}` },
    });
    const { ticket } = SocketTicket.parse(await response.json());
    const client = await f.open();
    client.send({ type: "hello", protocolVersion: 1, deviceId: pairing.device.id, ticket });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    return client;
  };
  const read = async (client: Awaited<ReturnType<typeof open>>, afterCursor: number) => {
    client.send({ type: "notification.feed", requestId: "feed", afterCursor });
    const reply = await client.next();
    if (reply.type !== "notification.feed.result") throw new Error(`Unexpected ${reply.type}`);
    return reply;
  };
  const direct = await open(lan);
  direct.send({
    type: "notification.register",
    requestId: "register",
    device: { channel: "websocket", platform: "phone" },
  });
  expect(await direct.next()).toMatchObject({ type: "notification.register.result" });
  direct.send({ type: "presence.update", threadId: null, inputAgeMs: 0, appState: "background" });
  await presence("background");
  await direct.close();
  await status("done");

  // A wake over the other route: nothing was recorded for that id, and it still reads the alert.
  const wake = await open(tunnel);
  const missed = await read(wake, 0);
  expect(missed.entries.map((entry) => entry.notification.status)).toEqual(["done"]);
  // Back on the first route with the cursor the wake saved: nothing is skipped or shown twice.
  const back = await open(lan);
  expect((await read(back, missed.cursor)).entries).toEqual([]);
  expect((await read(back, 0)).entries.map((entry) => entry.notification.id)).toEqual(
    missed.entries.map((entry) => entry.notification.id),
  );
});
