import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import { runStatusLine, runToasts } from "./toast-rules.ts";

const prefs = { needsYou: true, failures: true, automations: true, browser: false };
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

test("a run that starts and finishes between two reads still gets its toast, once", () => {
  // Opened at 1_000; the first read already shows the run finished at 1_500.
  const causes = runToasts([run("quick", 1_500)], prefs, 1_000, new Set());
  expect(causes.map((cause) => cause.kind === "automation" && cause.run.id)).toEqual(["quick"]);
  expect(runToasts([run("quick", 1_500)], prefs, 1_000, new Set(["quick"]))).toEqual([]);
});

test("runs that finished before the app opened, or are still going, raise nothing", () => {
  expect(runToasts([run("old", 900), run("going", undefined)], prefs, 1_000, new Set())).toEqual(
    [],
  );
  expect(
    runToasts([run("quick", 1_500)], { ...prefs, automations: false }, 1_000, new Set()),
  ).toEqual([]);
});

test("a system notification about a run says what happened, never what it printed", () => {
  const failed = { ...run("secret", 1_500), status: "failed" as const, result: "token=abc123" };
  expect(runStatusLine(failed)).toBe("The automation run failed");
  expect(runStatusLine(failed)).not.toContain("abc123");
  expect(runStatusLine(run("ok", 1_500))).toBe("The automation run finished");
});
