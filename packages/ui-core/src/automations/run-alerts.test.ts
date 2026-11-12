import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import { finishedSince, runAlertTitle, runStatusLine } from "./run-alerts.ts";

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

test("a run that starts and finishes between two reads is still news, once", () => {
  // Watched from 1_000; the first read already shows the run finished at 1_500.
  expect(finishedSince([run("quick", 1_500)], 1_000, new Set()).map((r) => r.id)).toEqual([
    "quick",
  ]);
  expect(finishedSince([run("quick", 1_500)], 1_000, new Set(["quick"]))).toEqual([]);
});

test("runs that finished before watching began, or are still going, are not news", () => {
  expect(finishedSince([run("old", 900), run("going", undefined)], 1_000, new Set())).toEqual([]);
});

test("an alert names the automation and whether its run failed or finished", () => {
  expect(runAlertTitle({ ...run("a", 1_500), status: "failed" })).toBe("Nightly audit failed");
  expect(runAlertTitle(run("a", 1_500))).toBe("Nightly audit finished");
});

test("a system notification about a run says what happened, never what it printed", () => {
  const failed = { ...run("secret", 1_500), status: "failed" as const, result: "token=abc123" };
  expect(runStatusLine(failed)).toBe("The automation run failed");
  expect(runStatusLine(failed)).not.toContain("abc123");
  expect(runStatusLine(run("ok", 1_500))).toBe("The automation run finished");
});
