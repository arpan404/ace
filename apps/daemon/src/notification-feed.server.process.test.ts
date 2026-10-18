import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceId, Notification } from "@ace/protocol";
import { NotificationWorker, attachNotifications, createNotificationRouter } from "@ace/notify";
import { afterEach, expect, it } from "vitest";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A real daemon socket and notification worker on temp SQLite; the client is an iPhone app. */
async function phone() {
  const home = mkdtempSync(join(tmpdir(), "ace-notify-feed-"));
  let sender: (device: DeviceId, notification: Notification) => boolean = () => false;
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
