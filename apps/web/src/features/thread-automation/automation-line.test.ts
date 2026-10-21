import type { Automation, AutomationSchedule, AutomationTrigger } from "@ace/protocol";
import { formatClock } from "@ace/ui-core";
import { expect, test } from "vitest";
import { automationLine, lineText, type LineFacts } from "./automation-line.ts";
import type { ThreadAutomation } from "./thread-automations-source.ts";

// 22:00 UTC on 21 Oct 2026: a 2:00 AM run is tonight's.
const now = Date.UTC(2026, 9, 21, 22, 0);
const tonight = Date.UTC(2026, 9, 22, 2, 0);
const facts: LineFacts = { now, localZone: "UTC" };
// The reader's locale writes the clock ("2:00 AM" in en-US).
const twoAm = formatClock(tonight, undefined, "UTC");

const schedule: AutomationSchedule = {
  kind: "rrule",
  expression: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
  timezone: "UTC",
  startAt: Date.UTC(2026, 9, 1),
};
const daily: AutomationTrigger = { kind: "schedule", schedule };

function entry(
  change: Partial<Automation> = {},
  rest: Partial<Omit<ThreadAutomation, "automation">> = {},
): ThreadAutomation {
  return {
    automation: {
      id: "auto-1",
      title: "Daily check",
      enabled: true,
      workspace: "/code/relay",
      provider: "claude",
      prompt: "Check the build",
      worktree: false,
      trigger: daily,
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
      ...change,
    },
    threadId: "thread-1",
    nextRunAt: tonight,
    revision: 3,
    triggerError: undefined,
    lastRun: undefined,
    ...rest,
  };
}

const text = (entries: ThreadAutomation[]) => {
  const line = automationLine(entries, facts);
  return line && lineText(line);
};

test("a scheduled automation says when it runs and when next, with Pause and Open", () => {
  expect(text([entry()])).toBe(`Daily check · runs every day at ${twoAm} · next tonight · Pause · Open`);
});

test("Open goes to the automation, and Pause carries its revision", () => {
  expect(automationLine([entry()], facts)?.actions).toEqual([
    { kind: "pause", id: "auto-1", revision: 3 },
    { kind: "open", automationId: "auto-1" },
  ]);
});

test("a running automation says so in the working colour, with how long ago and its run", () => {
  const line = automationLine(
    [
      entry(
        {},
        {
          lastRun: {
            id: "run-1",
            automationId: "auto-1",
            title: "Daily check",
            eventKey: "schedule",
            trigger: "schedule",
            status: "running",
            startedAt: now - 2 * 60_000,
            threadId: "thread-run-1",
          },
        },
      ),
    ],
    facts,
  );
  expect(line && lineText(line)).toBe("Running Daily check · started 2m ago · Open run");
  expect(line?.segments[0]?.status).toEqual({ word: "Running", tone: "working" });
  expect(line?.actions).toEqual([{ kind: "open-run", threadId: "thread-run-1" }]);
});

test("a paused automation says what it would run on, with Resume", () => {
  expect(text([entry({ enabled: false }, { nextRunAt: undefined })])).toBe(
    `Paused · Daily check · runs every day at ${twoAm} · Resume`,
  );
});

test("a file trigger that broke says it is not watching, and why, in the failed colour", () => {
  const line = automationLine(
    [
      entry(
        { trigger: { kind: "file", paths: ["~/code/relay"] } },
        {
          nextRunAt: undefined,
          triggerError: { message: "~/code/relay is gone.", at: now },
        },
      ),
    ],
    facts,
  );
  expect(line && lineText(line)).toBe("Not watching Daily check · ~/code/relay is gone · Open");
  expect(line?.segments[0]?.status?.tone).toBe("failed");
});

test("several automations on one thread are counted, with the soonest next run", () => {
  const later = entry({ id: "auto-2", title: "Weekly sweep" }, { nextRunAt: tonight + 86_400_000 });
  expect(text([later, entry()])).toBe(`2 automations · next tonight ${twoAm} · Open`);
  expect(automationLine([later, entry()], facts)?.actions).toEqual([
    { kind: "open", automationId: undefined },
  ]);
});

test("a GitHub trigger says what it waits for, and nothing about a next time", () => {
  const github: AutomationTrigger = {
    kind: "github",
    repository: "arpan404/ace",
    event: "ci_failed",
    pollIntervalMs: 60_000,
  };
  expect(text([entry({ trigger: github }, { nextRunAt: undefined })])).toBe(
    "Daily check · runs when CI fails in arpan404/ace · Pause · Open",
  );
});

test("a schedule kept in another zone names it", () => {
  const zoned: AutomationTrigger = {
    kind: "schedule",
    schedule: { ...schedule, timezone: "Asia/Kathmandu" },
  };
  expect(text([entry({ trigger: zoned }, { nextRunAt: undefined })])).toBe(
    `Daily check · runs every day at ${twoAm} (Asia/Kathmandu) · Pause · Open`,
  );
});

test("a thread without automations has no line", () => {
  expect(automationLine([], facts)).toBeUndefined();
});
