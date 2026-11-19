import { expect, test } from "vitest";
import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { entry } from "./test-entries.fixture.ts";
import { threadCard } from "./thread-card.ts";
import { placeReader, placeThread, threadTabs } from "./thread-place.ts";
import { inboxStatus } from "./mobile-inbox.ts";
import { wokeAtEnd, wokeSentence } from "./snooze-woke.ts";

const now = new Date("2026-11-03T15:00:00").getTime();
const minute = 60_000;
const hour = 60 * minute;
const wokeAt = now - 10 * minute;
const checksFailed = { on: "pr", at: wokeAt, number: 1477, change: "checks_failed" } as const;

/** Finished and read an hour ago, then snoozed until the PR changed; its checks failed. */
const back = (extra: Record<string, unknown> = {}, status: ThreadStatus = { state: "done" }) =>
  entry("back", status, now - 2 * hour, {
    activityAt: now - 2 * hour,
    readAt: now - hour,
    snoozeWoke: checksFailed,
    ...extra,
  });

const card = (value: ThreadListEntry) =>
  threadCard({ entry: value, baseline: 0, settled: false, now, locale: "en-US" });

test("a thread back from its snooze says why on its row until the person reads it", () => {
  expect(card(back()).woke).toEqual({
    short: "checks failed",
    sentence: "Back from snooze: checks failed on #1477",
  });
  expect(card(back({ readAt: now - minute })).woke).toBeUndefined();
});

test("a running thread's own status outranks why it woke", () => {
  expect(card(back({}, { state: "working", agents: 1 })).woke).toBeUndefined();
});

test("a recovery to act on outranks why it woke, on the row and its hover card", () => {
  const queue = { revision: 2, paused: true, reason: "uncertain", resumeAt: null, pendingCount: 1 };
  expect(card(back({ queue })).woke).toBeUndefined();
});

test("snoozed again or settled, a thread no longer says it is back", () => {
  expect(card(back({ snoozedUntil: now + hour })).woke).toBeUndefined();
  expect(card(back({ settledAt: now - minute, settledReason: "manual" })).woke).toBeUndefined();
});

test("a thread back from its snooze sits with unseen work, ordered by when it woke", () => {
  const input = { baseline: 0, now, sortBy: "activity" } as const;
  const list = [
    // Finished five minutes after the wake but already read: idle.
    entry("idle", { state: "done" }, now - 5 * minute, { readAt: now }),
    // Finished unread twenty minutes ago: older than the wake.
    entry("unseen", { state: "done" }, now - 20 * minute),
    back(),
  ].map((each) => Object.assign({}, each, { place: placeThread(each, input) }));
  expect(threadTabs(list, placeReader({ fallback: input })).inbox).toEqual([
    "back",
    "unseen",
    "idle",
  ]);
});

test("the phone's row says why it woke until read", () => {
  const thread = { key: "mac/back", machineId: "mac", entry: back(), unconfirmed: false };
  expect(inboxStatus(thread, now).label).toBe("Back · checks failed");
  const read = { ...thread, entry: back({ readAt: now }) };
  expect(inboxStatus(read, now).label).toBe("Done");
});

test("the transcript ends with why it woke, read or not, until the thread works again", () => {
  expect(wokeAtEnd(back({ readAt: now }), now)).toEqual(checksFailed);
  expect(wokeAtEnd(back({ activityAt: now - minute }), now)).toBeUndefined();
});

test.each([
  [{ on: "time", at: 1 } as const, "Back from snooze: its time came"],
  [
    { on: "needs_you", at: 1, outcome: "finished" } as const,
    "Back from snooze: the agent finished",
  ],
  [{ on: "pr", at: 1, number: 9, change: "merged" } as const, "Back from snooze: #9 was merged"],
])("a wake reads in plain words: %o", (woke, sentence) => {
  expect(wokeSentence(woke)).toBe(sentence);
});
