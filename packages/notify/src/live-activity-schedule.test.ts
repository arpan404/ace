import { expect, it } from "vitest";
import {
  activityDecision,
  activityOrder,
  classifyActivityThread,
  type ActivitySchedule,
} from "./live-activity-schedule.ts";

const empty = {
  needsYou: 0,
  working: 0,
  failed: 0,
  waiting: 0,
  limited: 0,
  background: 0,
  done: 0,
};
const working = { ...empty, working: 1 };
const initial: ActivitySchedule = {
  now: 10_000,
  counts: working,
  settledSince: undefined,
  frequentUpdates: true,
  quiet: false,
};

it.each([
  ["a pending remote child", { row: "idle", status: "done", pendingChild: true }, "working"],
  ["a child asking", { row: "needs-you", status: "needs_you", pendingChild: true }, "needs-you"],
  ["an unresponsive thread", { row: "idle", status: "unresponsive" }, "waiting"],
  ["wake grace", { row: "idle", status: "working" }, "working"],
  ["an unknown state", { row: "idle", status: "unknown" }, "waiting"],
  ["queued input", { row: "idle", status: "done", queued: true }, "waiting"],
  ["an uncertain send", { row: "needs-you", status: "failed", queued: true }, "needs-you"],
  [
    "a background shell left running",
    { row: "finished", status: "done", background: true },
    "background",
  ],
  ["a usage limit", { row: "idle", status: "limited" }, "limited"],
  ["an unseen failure", { row: "failed", status: "failed" }, "failed"],
  ["a seen failure", { row: "idle", status: "failed" }, "idle"],
] satisfies [string, Parameters<typeof classifyActivityThread>[0], string][])(
  "counts %s without losing the tree's live work",
  (_, facts, expected) => expect(classifyActivityThread(facts)).toBe(expected),
);

it("gives every busy stretch a new 120-second quiet window before ending", () => {
  expect(activityDecision({ ...initial, now: 300_000 })).toEqual({ event: "update", priority: 5 });
  expect(
    activityDecision({ ...initial, counts: empty, now: 419_999, settledSince: 300_000 }),
  ).toEqual({ at: 420_000 });
  expect(
    activityDecision({ ...initial, counts: empty, now: 420_000, settledSince: 300_000 }),
  ).toEqual({ event: "end", priority: 10 });
});

const last = { counts: working, at: 10_000 };

it.each([
  ["needs-you rises", working, { ...empty, needsYou: 1 }],
  ["failed rises", working, { ...working, failed: 1 }],
  ["needs-you clears", { ...empty, needsYou: 1 }, working],
])("sends immediately at priority 10 when %s", (_, before, counts) => {
  const input = { ...initial, last: { counts: before, at: 10_000 }, now: 11_000, counts };
  expect(activityDecision(input)).toEqual({ event: "update", priority: 10 });
  expect(activityDecision({ ...input, quiet: true })).toEqual({ at: 40_000 });
});

it("coalesces the latest counts and spaces out another push in the same second", () => {
  expect(activityDecision({ ...initial, last, counts: { ...working, working: 2 } })).toEqual({
    at: 40_000,
  });
  expect(
    activityDecision({ ...initial, last, now: 10_999, counts: { ...working, needsYou: 1 } }),
  ).toEqual({ at: 11_000 });
  expect(
    activityDecision({ ...initial, last, now: 40_000, counts: { ...working, working: 3 } }),
  ).toEqual({ event: "update", priority: 5 });
});

it.each([
  [true, 40_000, 610_000],
  [false, 70_000, 1_210_000],
])(
  "coalesces and heartbeats with frequent updates set to %s",
  (frequentUpdates, next, heartbeat) => {
    const input = { ...initial, last, frequentUpdates };
    expect(activityDecision({ ...input, counts: { ...working, waiting: 1 } })).toEqual({
      at: next,
    });
    expect(activityDecision({ ...input, now: heartbeat - 1 })).toEqual({ at: heartbeat });
    expect(activityDecision({ ...input, now: heartbeat })).toEqual({
      event: "update",
      priority: 5,
    });
  },
);

it("waits out Retry-After and puts a quiet end through at priority 5", () => {
  const input = { ...initial, counts: empty, settledSince: 0, quiet: true, retryAt: 150_000 };
  expect(activityDecision({ ...input, now: 120_000 })).toEqual({ at: 150_000 });
  expect(activityDecision({ ...input, now: 150_000 })).toEqual({ event: "end", priority: 5 });
});

it("advances both values from a recovered watermark even if wall time went backward", () => {
  expect(activityOrder({ seq: 51, timestamp: 73 }, 10_000)).toEqual({ seq: 52, timestamp: 74 });
});
