import { expect, test } from "vitest";
import type { Thread } from "@ace/protocol";

type QueueState = NonNullable<Thread["queue"]>;
import { queueWakesSnooze } from "./thread-attention.ts";

const now = 1_000_000;
const running: QueueState = { revision: 1, paused: false, reason: null, resumeAt: null };
const held = (reason: QueueState["reason"], revision = 2): QueueState => ({
  revision,
  paused: true,
  reason,
  resumeAt: null,
  pendingCount: 1,
});

test("a snoozed thread wakes when its queue newly needs recovery", () => {
  const thread = { queue: running, snoozedUntil: now + 60_000 };
  expect(queueWakesSnooze(thread, held("not_sent"), now)).toBe(true);
  expect(queueWakesSnooze(thread, held("restart"), now)).toBe(true);
});

test("a thread snoozed during recovery stays asleep while the same hold carries on", () => {
  const thread = { queue: held("restart"), snoozedUntil: now + 60_000 };
  expect(queueWakesSnooze(thread, held("restart", 3), now)).toBe(false);
  expect(queueWakesSnooze(thread, held("uncertain", 3), now)).toBe(true);
});

test("queue changes that need no one leave a snooze alone", () => {
  const thread = { queue: held("restart"), snoozedUntil: now + 60_000 };
  expect(queueWakesSnooze(thread, running, now)).toBe(false);
  expect(queueWakesSnooze(thread, { ...held("limit"), resumeAt: now + 1 }, now)).toBe(false);
  expect(queueWakesSnooze(thread, { ...held("manual"), pendingCount: 0 }, now)).toBe(false);
});

test("a thread that isn't snoozed has nothing to wake", () => {
  expect(queueWakesSnooze({ queue: running }, held("not_sent"), now)).toBe(false);
  expect(queueWakesSnooze({ queue: running, snoozedUntil: now }, held("not_sent"), now)).toBe(
    false,
  );
});
