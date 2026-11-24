import { afterEach, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(outcome: Parameters<typeof setup>[0] = "accepted") {
  const f = setup(outcome);
  fixtures.push(f);
  return f;
}

it("a phone catches up on an alert it missed exactly once, by cursor", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  const first = f.service.feed(f.phone, 0);
  expect(first.entries.map((entry) => entry.notification.status)).toEqual(["done"]);
  expect(first.cursor).toBe(first.entries[0]?.cursor);
  expect(f.service.feed(f.phone, first.cursor).entries).toEqual([]);
  f.start();
  f.end("failed");
  await f.flush();
  const second = f.service.feed(f.phone, first.cursor);
  expect(second.entries.map((entry) => entry.notification.status)).toEqual(["failed"]);
  expect(second.cursor).toBeGreaterThan(first.cursor);
});

it("catch-up keeps only phones: a desktop has no feed entries", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  expect(f.service.feed(f.desktop, 0)).toMatchObject({ entries: [], retracted: [] });
});

it("retried deliveries of one alert leave a single catch-up entry", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  for (let i = 0; i < 4; i++) {
    f.setTime(1000 + 120_000 * (i + 1));
    await f.service.drain();
  }
  expect(f.deliveries.filter((d) => d.device.id === f.phone).length).toBeGreaterThan(1);
  expect(f.service.feed(f.phone, 0).entries).toHaveLength(1);
});

it("catch-up never offers a done alert once the thread is working again, and retracts it", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  const id = f.service.feed(f.phone, 0).entries[0]?.notification.id;
  f.start();
  const feed = f.service.feed(f.phone, 0);
  expect(feed.entries).toEqual([]);
  expect(feed.retracted).toEqual([{ id, threadId: f.threadId }]);
});

it("an alert suppressed because the thread is in use elsewhere is not caught up later", async () => {
  const f = fixture();
  f.service.updatePresence("desk", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.start();
  f.end();
  await f.flush();
  expect(f.service.feed(f.phone, 0).entries).toEqual([]);
});

it("a snoozed thread's alert is withheld from catch-up", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  f.service.snooze(f.threadId, 10_000_000);
  expect(f.service.feed(f.phone, 0).entries).toEqual([]);
});

it("the feed survives a restart, and a cursor from a rebuilt database starts over", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  await f.reopen();
  expect(f.service.feed(f.phone, 0).entries).toHaveLength(1);
  expect(f.service.feed(f.phone, 1_000_000).entries).toHaveLength(1);
});

it("a revoked phone loses its catch-up feed", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  f.service.revoke(f.phone);
  expect(() => f.service.feed(f.phone, 0)).toThrow();
});

it("a phone's live alert carries its catch-up cursor, the same on every retry", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  for (let i = 0; i < 2; i++) {
    f.setTime(1000 + 120_000 * (i + 1));
    await f.service.drain();
  }
  const cursor = f.service.feed(f.phone, 0).entries[0]?.cursor;
  const sent = f.deliveries
    .filter((d) => d.device.id === f.phone)
    .map((d) => d.notification.cursor);
  expect(sent.length).toBeGreaterThan(1);
  expect(new Set(sent)).toEqual(new Set([cursor]));
  expect(f.deliveries.find((d) => d.device.id === f.desktop)?.notification.cursor).toBeUndefined();
});

it("a linked device's read includes alerts recorded only for the other id, each once", async () => {
  const f = fixture();
  // The relay route's account id: connected, with nothing recorded for it.
  const relay = DeviceId.parse("relay");
  f.service.connectDevice(relay);
  f.start();
  f.end();
  await f.flush();
  expect(f.service.feed(relay, 0).entries).toEqual([]);
  const linked = f.service.feed(relay, 0, undefined, [f.phone]);
  expect(linked.entries.map((entry) => entry.notification.status)).toEqual(["done"]);
  expect(linked.cursor).toBe(linked.entries[0]?.cursor);
  // Registered both ways, the alert is recorded twice and still read once.
  f.service.register(relay, { channel: "apns", platform: "phone", token: "cd".repeat(32) });
  f.start();
  f.end("failed");
  await f.flush();
  const both = f.service.feed(f.phone, linked.cursor, undefined, [relay]);
  expect(both.entries.map((entry) => entry.notification.status)).toEqual(["failed"]);
  // The checkpoint stays the reading device's own.
  f.service.feed(relay, both.cursor, true, [f.phone]);
  expect(f.service.feed(relay, undefined, undefined, [f.phone]).entries).toEqual([]);
  const phone = f.service.feed(f.phone, undefined, undefined, [relay]);
  expect(phone.entries.map((entry) => entry.notification.status)).toEqual(["failed"]);
});

it("a device's feed reports the newest cursor it holds, not the inbox head", async () => {
  const f = fixture();
  f.start();
  f.end();
  await f.flush();
  const phone = f.service.feed(f.phone, 0);
  expect(phone.seen).toBe(phone.entries[0]?.cursor);
  // A desktop holds none of the inbox: its head moved, its own cursor did not.
  const desktop = f.service.feed(f.desktop, 0);
  expect(desktop.cursor).toBeGreaterThan(0);
  expect(desktop.seen).toBe(0);
  // With nothing newer, a phone's own cursor is where it stopped reading.
  expect(f.service.feed(f.phone, phone.cursor).seen).toBe(phone.cursor);
});
