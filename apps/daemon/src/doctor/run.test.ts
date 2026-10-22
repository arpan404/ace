import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DiagnosticReport } from "@ace/protocol";
import type { DoctorFeature } from "./feature.ts";
import { recentErrors } from "./recent-errors.ts";
import { applyFeatureRepairs, collectFullReport, planAllRepairs } from "./run.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const empty: DiagnosticReport = { at: 0, checks: [] };

it("a chosen repair runs in the feature that offered it, and a throwing repair reads as failed", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const ran: string[] = [];
  const features: DoctorFeature[] = [
    {
      id: "storage",
      checks: () => [],
      repairs: () => [
        { id: "storage.backup", title: "Delete old backup", detail: "", recommended: false },
      ],
      apply: async (id) => {
        ran.push(id);
        return [{ id, status: "fixed", message: "Deleted" }];
      },
    },
    {
      id: "locks",
      checks: () => [],
      apply: async () => {
        throw new Error("Lock is held by a live process");
      },
    },
  ];
  expect((await planAllRepairs(empty, context, features)).map((repair) => repair.id)).toEqual([
    "storage.backup",
  ]);
  const results = await applyFeatureRepairs(
    ["storage.backup", "locks.stale", "folders"],
    empty,
    context,
    features,
  );
  expect(ran).toEqual(["storage.backup"]);
  expect(results).toEqual([
    { id: "storage.backup", status: "fixed", message: "Deleted" },
    { id: "locks.stale", status: "failed", message: "Lock is held by a live process" },
  ]);
});

it("recent errors are summarized from the log, and a quiet day passes", async () => {
  const { context, dataDir, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const check = recentErrors.checks(context)[0];
  if (!check) throw new Error("missing check");
  const signal = new AbortController().signal;
  expect((await check.run(signal)).status).toBe("ok");
  const now = context.now();
  await mkdir(join(dataDir, "logs"));
  await writeFile(
    join(dataDir, "logs", "ace.jsonl"),
    [
      { at: now - 1_000, level: "error", component: "engine", message: "Stop timed out" },
      { at: now - 2_000, level: "error", component: "engine", message: "Stop timed out" },
      { at: now - 3_000, level: "warn", component: "ace", message: "WebSocket closed" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const verdict = await check.run(signal);
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain("2 errors and 1 warning in the last 24 hours");
  expect(verdict.message).toContain("Most frequent error: 2× engine: Stop timed out");
});

it("doctor removes secret values from messages but keeps versions and the home folder readable", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const secret = "sk-live-abcdef1234567890";
  const withEnv = {
    ...context,
    env: { ...context.env, ACE_VERSION: "0.0.4", ACE_TEST_TOKEN: secret },
  };
  const report = await collectFullReport(withEnv, [
    {
      id: "echo",
      checks: () => [
        {
          id: "echo.values",
          fix: "",
          run: async () => ({
            status: "ok",
            message: `version 0.0.4, token ${secret}, folder ${context.home}/.ace`,
            fix: "",
          }),
        },
      ],
    },
  ]);
  const message = report.checks.find((check) => check.id === "echo.values")?.message ?? "";
  expect(message).toContain("version 0.0.4");
  expect(message).not.toContain(secret);
});
