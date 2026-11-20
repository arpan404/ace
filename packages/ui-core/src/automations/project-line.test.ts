import type { Automation } from "@ace/protocol";
import { expect, test } from "vitest";
import type { AutomationEntry } from "./lists.ts";
import { projectAutomationsLine, projectSchedules } from "./project-line.ts";

const now = Date.UTC(2026, 9, 21, 12, 0);
const hour = 3_600_000;

function entry(
  id: string,
  patch: Partial<Automation> = {},
  nextRunAt: number | undefined = undefined,
): AutomationEntry {
  return {
    automation: {
      id,
      title: id,
      enabled: true,
      workspace: "ace",
      provider: "claude",
      prompt: "Do it.",
      worktree: true,
      trigger: {
        kind: "schedule",
        schedule: {
          kind: "rrule",
          expression: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
          timezone: "UTC",
          startAt: 0,
        },
      },
      missedRun: "run_once",
      concurrency: 1,
      jitterMs: 0,
      ...patch,
    },
    nextRunAt,
    revision: 1,
    lastPollError: undefined,
    triggerError: undefined,
    lastRun: undefined,
    owner: undefined,
    webhook: undefined,
  };
}

const facts = { now, localZone: "UTC" };

test("a project's schedules count, with the soonest enabled one's start after them", () => {
  const line = projectAutomationsLine(
    [
      entry("late", {}, now + 5 * hour),
      entry("soon", {}, now + hour),
      entry("paused", { enabled: false }, now + 10),
    ],
    facts,
  );
  expect(line).toBe("3 automations in this project · next today 1:00 PM · in 1h");
});

test("one schedule with no start known yet reads as its count alone", () => {
  expect(projectAutomationsLine([entry("a")], facts)).toBe("1 automation in this project");
});

test("a project without schedules shows no line", () => {
  expect(projectAutomationsLine([], facts)).toBeNull();
});

test("with automations off on the machine the line says nothing runs instead of promising a start", () => {
  expect(projectAutomationsLine([entry("a", {}, now + hour)], { ...facts, running: false })).toBe(
    "1 automation in this project · Automations are off on this machine.",
  );
});

test("only schedules that start in this project, by id or by its folder, belong to it", () => {
  const github: Partial<Automation> = {
    trigger: { kind: "manual" },
  };
  const entries = [
    entry("by-id"),
    entry("by-path", { workspace: "/Users/me/ace" }),
    entry("elsewhere", { workspace: "other" }),
    entry("manual", github),
  ];
  expect(
    projectSchedules(entries, { id: "ace", path: "/Users/me/ace" }).map((e) => e.automation.id),
  ).toEqual(["by-id", "by-path"]);
  expect(projectSchedules(entries, { id: "ace" }).map((e) => e.automation.id)).toEqual(["by-id"]);
});
