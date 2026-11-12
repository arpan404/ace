import type { Automation } from "@ace/protocol";
import { expect, test } from "vitest";
import type { AutomationEntry } from "./lists.ts";
import { projectAutomationsLine, projectSchedules } from "./project-line.ts";
import { automationsOffText } from "./sidebar-rows.ts";

const now = Date.UTC(2026, 9, 21, 12, 0);
const hour = 3_600_000;
const facts = { now, localZone: "UTC", running: true };

const daily: Automation["trigger"] = {
  kind: "schedule",
  schedule: {
    kind: "rrule",
    expression: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0",
    timezone: "UTC",
    startAt: 0,
  },
};

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
      trigger: daily,
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
  };
}

test("a project's schedules are those on a schedule naming its id or its folder", () => {
  const entries = [
    entry("by-id"),
    entry("by-folder", { workspace: "/code/ace" }),
    entry("elsewhere", { workspace: "relay" }),
    entry("by-hand", { trigger: { kind: "manual" } }),
  ];
  expect(
    projectSchedules(entries, "ace", "/code/ace").map((schedule) => schedule.automation.id),
  ).toEqual(["by-id", "by-folder"]);
  expect(projectSchedules(entries, "ace", undefined)).toHaveLength(1);
});

test.each([
  {
    case: "none says nothing",
    schedules: [],
    facts,
    line: undefined,
  },
  {
    case: "the soonest enabled start leads, lower-cased mid-sentence",
    schedules: [
      entry("later", {}, now + 30 * hour),
      entry("soon", {}, now + 14 * hour),
      entry("paused", { enabled: false }, now + hour),
    ],
    facts,
    line: /^3 automations in this project · next tomorrow/,
  },
  {
    case: "one with no start yet says only how many",
    schedules: [entry("unplaced", { enabled: false })],
    facts,
    line: "1 automation in this project",
  },
  {
    case: "with automations off on the machine, no start is promised",
    schedules: [entry("soon", {}, now + hour)],
    facts: { ...facts, running: false },
    line: `1 automation in this project · next ${automationsOffText.charAt(0).toLowerCase()}${automationsOffText.slice(1)}`,
  },
])("the project's line: $case", ({ schedules, facts: given, line }) => {
  const said = projectAutomationsLine(schedules, given);
  if (line instanceof RegExp) expect(said).toMatch(line);
  else expect(said).toBe(line);
});
