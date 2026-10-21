import { expect, test } from "vitest";
import {
  canRetryTrigger,
  scheduleState,
  sidebarNeedsAttention,
  triggerErrorCopy,
} from "./trigger-health.ts";

test("sidebar failures come from this automation's own last run, not the global inbox", () => {
  const base = { triggerError: undefined, lastPollError: undefined, enabled: true };
  expect(
    sidebarNeedsAttention({
      ...base,
      lastRun: {
        id: "run-1",
        automationId: "auto-a",
        title: "A",
        eventKey: "manual:req",
        trigger: "manual",
        status: "failed",
        startedAt: 1000,
      },
    }),
  ).toBe(true);
  expect(
    sidebarNeedsAttention({
      ...base,
      lastRun: {
        id: "run-2",
        automationId: "auto-a",
        title: "A",
        eventKey: "manual:req",
        trigger: "manual",
        status: "succeeded",
        startedAt: 1000,
      },
    }),
  ).toBe(false);
});

test("a stored trigger error offers a safe retry with a fix in words", () => {
  expect(canRetryTrigger({ triggerError: undefined })).toBe(false);
  expect(canRetryTrigger({ triggerError: { message: "gh auth required: 401", at: 1000 } })).toBe(
    true,
  );
  expect(triggerErrorCopy({ message: "gh auth required: 401", at: 1000 })).toMatch(
    /Sign in to GitHub/i,
  );
  expect(triggerErrorCopy({ message: "boom", at: 1000 })).not.toMatch(/boom/);
});

test("an exhausted COUNT schedule reads finished, not merely unscheduled", () => {
  const schedule = {
    kind: "rrule" as const,
    expression: "FREQ=DAILY;COUNT=1;BYHOUR=9;BYMINUTE=0",
    timezone: "UTC",
    startAt: Date.UTC(2026, 9, 2, 9, 0),
  };
  expect(scheduleState(schedule, undefined, Date.UTC(2026, 9, 5, 10, 0))).toBe("exhausted");
  expect(
    scheduleState(
      {
        kind: "rrule" as const,
        expression: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        timezone: "UTC",
        startAt: Date.UTC(2026, 9, 2, 9, 0),
      },
      undefined,
      Date.UTC(2026, 9, 5, 10, 0),
    ),
  ).toBe("not-placed");
});
