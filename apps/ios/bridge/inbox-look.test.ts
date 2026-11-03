import { ThreadListEntry } from "@ace/protocol";
import { expect, test } from "vitest";
import { inboxLook } from "./inbox-look.ts";

const now = Date.parse("2026-11-03T15:00:00Z");
const minute = 60_000;

/** Finished and read an hour ago, then snoozed until its PR changed; its checks failed. */
const thread = (extra: Record<string, unknown> = {}) => ({
  key: "mac/back",
  machineId: "mac",
  unconfirmed: false,
  entry: ThreadListEntry.parse({
    id: "back",
    workspaceId: "ace",
    title: "Prevent stream restarts",
    provider: "claude",
    createdAt: 0,
    updatedAt: now - 120 * minute,
    activityAt: now - 120 * minute,
    readAt: now - 60 * minute,
    status: { state: "done" },
    snoozeWoke: { on: "pr", at: now - 10 * minute, number: 1477, change: "checks_failed" },
    ...extra,
  }),
});

test("a phone row back from its snooze draws the alarm and why it woke until it is read", () => {
  expect(inboxLook(thread(), 0, now)).toMatchObject({
    icon: "woke",
    mode: "word",
    word: "checks failed",
    meaning: "Back from snooze: checks failed on #1477",
  });
  const read = inboxLook(thread({ readAt: now }), 0, now);
  expect(read.icon).not.toBe("woke");
  expect(read.mode).toBe("age");
});

test("a request on a woken thread keeps the phone row's request icon", () => {
  const asking = inboxLook(thread({ status: { state: "needs_you", interactions: 1 } }), 0, now);
  expect(asking.icon).not.toBe("woke");
  expect(asking.level).toBe("needs-you");
});
