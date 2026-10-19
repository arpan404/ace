import { afterEach, expect, it } from "vitest";
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
  expect(feed.retracted).toEqual([id]);
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
