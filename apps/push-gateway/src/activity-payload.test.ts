import { expect, it } from "vitest";
import { ActivityBody, activityPush } from "./activity-payload.ts";

const update = {
  v: 1,
  event: "update",
  timestamp: 1795500000,
  priority: 5,
  staleAfter: 900,
  state: {
    seq: 41,
    at: 1795500000,
    phase: "busy",
    needsYou: 1,
    working: 2,
    failed: 0,
    waiting: 0,
    limited: 0,
    background: 0,
    done: 3,
  },
};

const start = { ...update, event: "start", slot: 15 };
const end = { ...update, event: "end", dismissAfter: 900 };

it.each([
  ["top-level text", { ...update, title: "private title" }],
  ["local-only rows", { ...update, state: { ...update.state, rows: [] } }],
  ["a numeric string", { ...update, state: { ...update.state, needsYou: "1" } }],
  ["a fractional count", { ...update, state: { ...update.state, needsYou: 0.5 } }],
  ["an unknown phase", { ...update, state: { ...update.state, phase: "unknown" } }],
  ["a negative sequence", { ...update, state: { ...update.state, seq: -1 } }],
  ["an unknown version", { ...update, v: 2 }],
  ["an unsupported priority", { ...update, priority: 1 }],
  ["a stale interval under 60 seconds", { ...update, staleAfter: 59 }],
  ["a stale interval over an hour", { ...update, staleAfter: 3601 }],
  ["an update with a slot", { ...update, slot: 0 }],
  ["an update with a dismissal interval", { ...update, dismissAfter: 900 }],
  ["a start with a slot over 15", { ...start, slot: 16 }],
  ["a start without a slot", { ...start, slot: undefined }],
  ["an end without a dismissal interval", { ...end, dismissAfter: undefined }],
  ["a negative dismissal interval", { ...end, dismissAfter: -1 }],
  ["a dismissal interval over four hours", { ...end, dismissAfter: 14401 }],
] as const)("refuses %s", (_reason, request) => {
  expect(ActivityBody.safeParse(request).success).toBe(false);
});

it("allows the largest timestamp whose stale date can still be represented exactly", () => {
  const timestamp = Number.MAX_SAFE_INTEGER - 60;
  const push = activityPush(ActivityBody.parse({ ...update, timestamp, staleAfter: 60 }));
  expect(push.expiration).toBe(Number.MAX_SAFE_INTEGER);
  expect(
    ActivityBody.safeParse({ ...update, timestamp: timestamp + 1, staleAfter: 60 }).success,
  ).toBe(false);
});

it("rejects an end whose dismissal date would overflow", () => {
  const timestamp = Number.MAX_SAFE_INTEGER - 14400;
  const request = { ...end, timestamp, dismissAfter: 14400 };
  const push = activityPush(ActivityBody.parse(request));
  expect(JSON.parse(push.payload.toString()).aps["dismissal-date"]).toBe(Number.MAX_SAFE_INTEGER);
  expect(ActivityBody.safeParse({ ...request, timestamp: timestamp + 1 }).success).toBe(false);
});
