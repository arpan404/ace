import { afterEach, expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";
import { attachNotifications } from "./index.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(outcome: Parameters<typeof setup>[0] = "accepted") {
  const f = setup(outcome);
  fixtures.push(f);
  return f;
}

it("phone alerts are suppressed only by recent input on the same focused thread elsewhere", async () => {
  const f = fixture();
  f.service.updatePresence("session", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.map((d) => d.device.id)).toEqual([f.desktop]);
  f.service.updatePresence("session", f.desktop, {
    type: "presence.update",
    threadId: null,
    inputAgeMs: 0,
  });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.slice(1).map((d) => d.device.id)).toEqual([f.desktop, f.phone]);
});
it("presence expires after heartbeat or input inactivity and disconnect removes suppression", async () => {
  const f = fixture();
  f.service.updatePresence("s", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.setTime(62_000);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
  f.service.updatePresence("s", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 121_000,
  });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(4);
  f.service.updatePresence("s", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.service.disconnect("s");
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(6);
});
it("snooze blocks every channel and expires without replaying discarded alerts", async () => {
  const f = fixture();
  f.service.snooze(f.threadId, 10_000);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.setTime(10_000);
  await f.service.drain();
  expect(f.deliveries).toEqual([]);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
});
it("overnight quiet hours use the configured timezone and end at the exclusive boundary", async () => {
  const f = fixture();
  f.service.preferences(f.phone, {
    quietHours: { timeZone: "America/Chicago", startMinute: 22 * 60, endMinute: 7 * 60 },
    includePreview: false,
  });
  f.setTime(Date.parse("2026-11-01T06:30:00Z"));
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.map((d) => d.device.id)).toEqual([f.desktop]);
  f.setTime(Date.parse("2026-11-01T07:30:00Z"));
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.map((d) => d.device.id)).toEqual([f.desktop, f.desktop]);
  f.setTime(Date.parse("2026-11-01T13:00:00Z"));
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.slice(2).map((d) => d.device.id)).toEqual([f.desktop, f.phone]);
});
it("previews require an explicit per-device opt-in", async () => {
  const f = fixture();
  f.service.preferences(f.phone, { includePreview: true });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries[0]?.notification.preview).toBeUndefined();
  expect(f.deliveries[1]?.notification.preview).toBe("sensitive preview");
});
it("delivery retries follow exponential backoff and stop after five attempts", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
  for (const [time, expected] of [
    [6999, 2],
    [7000, 4],
    [8999, 4],
    [9000, 6],
    [13000, 8],
    [21000, 10],
    [100000, 10],
  ]) {
    if (time === undefined || expected === undefined) throw new Error("Invalid case");
    f.setTime(time);
    await f.service.drain();
    expect(f.deliveries).toHaveLength(expected);
  }
});
it("retry policy rechecks snooze and stale thread status", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  f.service.snooze(f.threadId, 100_000);
  f.setTime(7000);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(2);
  f.service.snooze(f.threadId, 0);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(4);
  f.start();
  f.setTime(13000);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(4);
});
it("a revoked device loses queued jobs, presence and its address and cannot re-register after restart", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  f.service.revoke(f.phone);
  await f.reopen();
  f.setOutcome("accepted");
  f.setTime(7000);
  await f.service.drain();
  expect(f.deliveries.slice(2).map((d) => d.device.id)).toEqual([f.desktop]);
  expect(() => f.service.register(f.phone, { channel: "websocket", platform: "phone" })).toThrow(
    "revoked",
  );
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries.slice(3).map((d) => d.device.id)).toEqual([f.desktop]);
});
it("vendor revocation stops future alerts while a permanent failure does not retry", async () => {
  const f = fixture("gone");
  f.start();
  f.end();
  await f.flush();
  f.setOutcome("accepted");
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
  const other = fixture("failed");
  other.start();
  other.end();
  await other.flush();
  await other.flush();
  expect(other.deliveries).toHaveLength(2);
});
it("restart preserves pending coalescing and retry deadlines with stable notification ids", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  const cursor = f.service.cursor();
  await f.reopen();
  expect(f.service.cursor()).toBe(cursor);
  f.service.ingest(f.history);
  await f.flush();
  const ids = f.deliveries.map((d) => d.notification.id);
  await f.reopen();
  f.setTime(6999);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(2);
  f.setOutcome("accepted");
  f.setTime(7000);
  await f.service.drain();
  expect(f.deliveries.slice(2).map((d) => d.notification.id)).toEqual(ids);
});
it("a cursor gap rolls back the batch and replay resumes without losing an alert", async () => {
  const f = fixture();
  f.start();
  f.end();
  const cursor = f.service.cursor();
  const last = f.history.at(-1);
  if (!last) throw new Error("Missing event");
  expect(() => f.service.ingest([{ ...last, seq: cursor + 2 }])).toThrow("gap");
  expect(f.service.cursor()).toBe(cursor);
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
  const errors: unknown[] = [];
  const listener = attachNotifications(
    f.service,
    {
      readEvents: ({ afterSeq, limit }) =>
        f.history.filter((event) => event.seq > afterSeq).slice(0, limit),
      subscribe: () => () => {},
    },
    (error) => errors.push(error),
  );
  await listener.tick();
  listener.close();
  expect(errors).toEqual([]);
  expect(f.deliveries).toHaveLength(2);
});

it("a retry from a previous completed turn cannot be delivered during a later completed turn", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  f.setTime(6500);
  f.start();
  f.end();
  f.setOutcome("accepted");
  f.setTime(7000);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(2);
  f.setTime(11500);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(4);
  expect(f.deliveries[2]?.notification.id).not.toBe(f.deliveries[0]?.notification.id);
});
it("archiving cancels alerts until unarchived and does not expose archived thread completions", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.append([{ type: "thread.updated", archivedAt: 1000 }]);
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toEqual([]);
  f.append([{ type: "thread.updated", archivedAt: null }]);
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
});
it("old event-log completion and expired retries are discarded rather than notifying on late replay", async () => {
  const f = fixture();
  f.start();
  f.end();
  f.setTime(86_401_001);
  await f.service.drain();
  expect(f.deliveries).toEqual([]);
});
it("presence on a different thread or the same device does not suppress a phone", async () => {
  const f = fixture();
  f.service.updatePresence("self", f.phone, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.service.updatePresence("other", f.desktop, {
    type: "presence.update",
    threadId: null,
    inputAgeMs: 0,
  });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(2);
});
it("same-day quiet hours and equal endpoints silence only the configured devices", async () => {
  const f = fixture();
  f.service.preferences(f.phone, {
    quietHours: { timeZone: "UTC", startMinute: 8 * 60, endMinute: 17 * 60 },
  });
  f.setTime(Date.parse("2026-10-02T08:00:00Z"));
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(1);
  f.setTime(Date.parse("2026-10-02T17:00:00Z"));
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(3);
  f.service.preferences(f.phone, { quietHours: { timeZone: "UTC", startMinute: 0, endMinute: 0 } });
  f.start();
  f.end();
  await f.flush();
  expect(f.deliveries).toHaveLength(4);
});

it("phone retry rechecks fresh presence and desktop retry rechecks changed quiet hours", async () => {
  const f = fixture("retry");
  f.start();
  f.end();
  await f.flush();
  f.service.updatePresence("active", f.desktop, {
    type: "presence.update",
    threadId: f.threadId,
    inputAgeMs: 0,
  });
  f.service.preferences(f.desktop, {
    quietHours: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
  });
  f.setTime(7000);
  await f.service.drain();
  expect(f.deliveries).toHaveLength(2);
});
