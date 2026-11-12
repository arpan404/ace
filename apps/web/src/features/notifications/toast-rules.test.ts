import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import { runToasts } from "./toast-rules.ts";

const prefs = { needsYou: true, failures: true, automations: true, limits: true, browser: false };
const run = (id: string, finishedAt: number | undefined): AutomationRun => ({
  id,
  automationId: "auto",
  title: "Nightly audit",
  eventKey: id,
  trigger: "schedule",
  status: finishedAt === undefined ? "running" : "succeeded",
  startedAt: 100,
  ...(finishedAt === undefined ? {} : { finishedAt }),
});

test("with automation alerts off, a run that just finished raises nothing", () => {
  expect(runToasts([run("quick", 1_500)], prefs, 1_000, new Set())).toHaveLength(1);
  expect(
    runToasts([run("quick", 1_500)], { ...prefs, automations: false }, 1_000, new Set()),
  ).toEqual([]);
});
