import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import { batchRunAlerts, finishedSince, runAlertTitle, runStatusLine } from "./run-alerts.ts";

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

const finished = (
  id: string,
  finishedAt: number,
  status: AutomationRun["status"] = "succeeded",
) => ({
  ...run(id, finishedAt),
  status,
});

test("a few runs that finished together are each said, newest first", () => {
  const batch = batchRunAlerts([finished("a", 2), finished("b", 4), finished("c", 3)]);
  expect(batch.shown.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  expect(batch.summary).toBeNull();
});

test("a pile of finished runs says the newest three, then how many more finished and failed", () => {
  const runs = Array.from({ length: 60 }, (_, index) =>
    finished(`r${index}`, 1_000 + index, index % 10 === 0 ? "failed" : "succeeded"),
  );
  const batch = batchRunAlerts(runs);
  expect(batch.shown.map((entry) => entry.id)).toEqual(["r59", "r58", "r57"]);
  expect(batch.summary).toEqual({
    count: 57,
    title: "57 more automation runs finished",
    body: "6 failed",
  });
  // Every run is either said or counted.
  expect(batch.shown.length + (batch.summary?.count ?? 0)).toBe(60);
});

test("four runs are all said: a summary never stands in for just one", () => {
  const batch = batchRunAlerts([1, 2, 3, 4].map((at) => finished(`r${at}`, at)));
  expect(batch.shown).toHaveLength(4);
  expect(batch.summary).toBeNull();
  const quiet = batchRunAlerts([1, 2, 3, 4, 5].map((at) => finished(`r${at}`, at)));
  expect(quiet.summary).toMatchObject({ count: 2, body: "None failed" });
});
