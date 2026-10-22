import type { Automation, AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import type { AutomationEntry } from "@/features/automation-data/index.ts";
import { sidebarGroups } from "./sidebar-rows.ts";

const now = Date.UTC(2026, 9, 21, 12, 0);
const hour = 3_600_000;

function entry(
  id: string,
  patch: Partial<Automation> = {},
  facts: Partial<AutomationEntry> = {},
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
    nextRunAt: undefined,
    revision: 1,
    lastPollError: undefined,
    triggerError: undefined,
    lastRun: undefined,
    owner: undefined,
    ...facts,
  };
}

const run = (status: AutomationRun["status"]): AutomationRun => ({
  id: "r",
  automationId: "x",
  title: "x",
  eventKey: "k",
  trigger: "schedule",
  status,
  startedAt: now - hour,
});

test("upcoming automations come soonest first, with those not scheduled after them", () => {
  const groups = sidebarGroups(
    {
      person: [
        entry("later", {}, { nextRunAt: now + 5 * hour }),
        entry("manual", { trigger: { kind: "manual" } }),
        entry("sooner", {}, { nextRunAt: now + hour }),
        entry("off", { enabled: false }),
      ],
      threads: [entry("agent", {}, { owner: "thread-1", nextRunAt: now + 2 * hour })],
    },
    now,
    "UTC",
  );
  expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
    ["Upcoming", ["sooner", "later", "manual"]],
    ["Paused", ["off"]],
    ["In threads", ["agent"]],
  ]);
  expect(groups[2]?.rows[0]?.owner).toBe("thread-1");
});

test("a row's meta line says when it runs next, or the status that needs a look", () => {
  const [upcoming] = sidebarGroups(
    {
      person: [
        entry("next", {}, { nextRunAt: now + 14 * hour }),
        entry("running", {}, { lastRun: run("running"), nextRunAt: now + hour }),
        entry("stopped", {}, { triggerError: { message: "gone", at: now } }),
        entry("failed", {}, { lastRun: run("failed") }),
      ],
      threads: [],
    },
    now,
    "UTC",
  );
  const meta = Object.fromEntries(
    (upcoming?.rows ?? []).map((row) => [row.id, [row.status?.word, row.detail]]),
  );
  expect(meta.next).toEqual([undefined, "Tomorrow 2:00 AM · Every day"]);
  expect(meta.running).toEqual(["Running", "Every day"]);
  expect(meta.stopped).toEqual(["Not watching", "Every day"]);
  expect(meta.failed).toEqual(["Failed", "Every day"]);
});

test("a search keeps only automations whose names contain it", () => {
  const groups = sidebarGroups(
    { person: [entry("Nightly audit"), entry("Flaky triage")], threads: [] },
    now,
    "UTC",
    "  FLAKY ",
  );
  expect(groups.flatMap((group) => group.rows.map((row) => row.title))).toEqual(["Flaky triage"]);
});
