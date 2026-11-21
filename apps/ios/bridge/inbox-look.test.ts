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

test("a phone row back from its snooze draws the alarm, saying why it woke to VoiceOver, until it is read", () => {
  expect(inboxLook(thread(), 0, now)).toMatchObject({
    icon: "woke",
    mode: "icon",
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

const live = (status: Record<string, unknown>) =>
  inboxLook(thread({ status, snoozeWoke: undefined, readAt: now }), 0, now).state;

test("the lock screen counts a row as working only while the daemon says its tree works", () => {
  // The root's own turn ended while two subagents still run: the daemon's status is the tree's.
  expect(live({ state: "working", agents: 2 })).toBe("working");
  expect(live({ state: "waiting", on: "queue" })).toBe("waiting");
  expect(live({ state: "waiting", on: "rate_limit" })).toBe("waiting");
  expect(live({ state: "waiting", on: "background_task" })).toBe("background");
  expect(live({ state: "limited", until: now + 60 * minute })).toBe("limited");
  expect(live({ state: "needs_you", interactions: 1 })).toBe("needs-you");
  expect(live({ state: "done" })).toBe("idle");
});

/** Finished after this phone started following the machine, and never opened anywhere. */
const finished = (extra: Record<string, unknown> = {}) =>
  inboxLook(
    thread({ snoozeWoke: undefined, readAt: undefined, activitySeq: 40, ...extra }),
    0,
    now,
  );

test("a finished row keeps its check until this phone reads through its last answer, then shows its age", () => {
  expect(finished().icon).toBe("done");
  // Read part way: the last answer is still unread.
  expect(finished({ readState: { lastSeenSeq: 30, updatedAt: now - minute } }).icon).toBe("done");
  const read = finished({ readState: { lastSeenSeq: 40, updatedAt: now - minute } });
  expect(read.icon).not.toBe("done");
  expect(read.mode).toBe("age");
  // Marked unread by hand: the check comes back whatever the cursor says.
  expect(
    finished({ unread: true, readState: { lastSeenSeq: 40, updatedAt: now - minute } }).icon,
  ).toBe("done");
});

test("a row whose work moved says where it went and opens it there, never its age", () => {
  const to = { hostId: "studio", name: "Studio", threadId: "there" };
  const look = inboxLook(
    thread({ status: { state: "moved", to }, snoozeWoke: undefined, readAt: now }),
    0,
    now,
  );
  expect(look).toMatchObject({
    mode: "word",
    word: "Moved to Studio",
    meaning: "Moved to Studio",
    icon: "background",
    state: "moved",
    moved: to,
  });
  // Every other row says nothing about a move.
  expect(inboxLook(thread({ snoozeWoke: undefined }), 0, now).moved).toBeNull();
});
