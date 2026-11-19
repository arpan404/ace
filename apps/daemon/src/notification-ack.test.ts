import { expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { ackTimeoutMs, createAckTracker } from "./notification-ack.ts";

const phone = DeviceId.parse("phone");
const other = DeviceId.parse("other");

function manual() {
  const scheduled: { run: () => void; ms: number }[] = [];
  const delay = (run: () => void, ms: number) => {
    const entry = { run, ms };
    scheduled.push(entry);
    return () => {
      const index = scheduled.indexOf(entry);
      if (index >= 0) scheduled.splice(index, 1);
    };
  };
  return {
    delay,
    scheduled,
    fireAll() {
      for (const entry of scheduled.splice(0)) entry.run();
    },
  };
}

test("an ack before the timeout delivers without a push", async () => {
  const tracker = createAckTracker(manual().delay);
  const waiting = tracker.wait(phone, "n:1");
  expect(tracker.pending).toBe(1);
  tracker.resolve(phone, "n:1");
  expect(await waiting).toBe(true);
  expect(tracker.pending).toBe(0);
});

test("no ack resolves false once the timeout fires", async () => {
  const timers = manual();
  const tracker = createAckTracker(timers.delay);
  const waiting = tracker.wait(phone, "n:1");
  expect(timers.scheduled.map((entry) => entry.ms)).toEqual([ackTimeoutMs]);
  expect(ackTimeoutMs).toBe(3000);
  timers.fireAll();
  expect(await waiting).toBe(false);
  expect(tracker.pending).toBe(0);
});

test("an ack names its device and alert: nothing else resolves", async () => {
  const timers = manual();
  const tracker = createAckTracker(timers.delay);
  const waiting = tracker.wait(phone, "n:1");
  // Another phone's ack, another alert's ack and a missing id leave the waiter held.
  tracker.resolve(other, "n:1");
  tracker.resolve(phone, "n:2");
  tracker.resolve(phone, "missing");
  expect(tracker.pending).toBe(1);
  timers.fireAll();
  expect(await waiting).toBe(false);
});

test("a replaced waiter resolves false, and waiting stays bounded", async () => {
  const timers = manual();
  const tracker = createAckTracker(timers.delay);
  const first = tracker.wait(phone, "n:1");
  const second = tracker.wait(phone, "n:1");
  expect(await first).toBe(false);
  tracker.resolve(phone, "n:1");
  expect(await second).toBe(true);
  const waiting: Promise<boolean>[] = [];
  for (let index = 0; index < 300; index++)
    waiting.push(tracker.wait(DeviceId.parse(`device-${index}`), "n:1"));
  expect(tracker.pending).toBeLessThanOrEqual(256);
  timers.fireAll();
  expect(await Promise.all(waiting)).not.toContain(true);
});
