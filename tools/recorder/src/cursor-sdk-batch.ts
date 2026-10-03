import { mkdir, writeFile, rename, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createRedactor } from "./redact.ts";
import { cursorSdkScenarios, type CursorSdkScenarioId } from "./cursor-sdk-scenarios.ts";
import { cursorSdkPlan } from "./cursor-sdk-plan.ts";
import { recordCursorSdkScenario, type CursorRecordingDependencies } from "./cursor-sdk.ts";

const autoReviewReason =
  "Auto-review availability could not be verified for this account/backend. SDK 1.0.35 exposes autoReview as a request option, but no public capability query confirms the backend classifier feature. No restricted turn was sent.";
const ResultSchema = z.object({
  scenario: z.enum(cursorSdkScenarios.map((scenario) => scenario.id)),
  outcome: z.enum(["started", "complete", "incomplete", "skipped"]),
  elapsedMs: z.number().nonnegative(),
  reason: z.string().optional(),
  recordingPolicy: z.enum(["scenario-policy", "full-access"]).optional(),
});
type Result = z.infer<typeof ResultSchema>;
const BatchReport = z.object({
  approval: z.string(),
  sdkVersion: z.literal("1.0.35"),
  model: z.literal("composer-2.5"),
  scenarioTimeCapMs: z.literal(180000),
  scenarios: z.array(ResultSchema),
  initialScenarios: z.array(ResultSchema).optional(),
  fullAccessApproval: z.string().optional(),
});
const behaviouralScenarios = cursorSdkScenarios.filter(
  (scenario) => !["full-access", "restricted-mcp", "mcp-image"].includes(scenario.id),
);
/** One durable admission per owner-approved batch, including failed attempts. No retries. */
export async function recordApprovedCursorSdkBatch(
  output: string,
  instance: { id: string; homeDir: string },
  deps: CursorRecordingDependencies,
) {
  await mkdir(output, { recursive: true });
  const reportPath = join(output, "recording-report.json");
  const results: Result[] = [];
  const report = () =>
    JSON.stringify(
      {
        approval: "Owner-approved 2026-10-03: all 15 scenarios, once each, no retries",
        sdkVersion: "1.0.35",
        model: "composer-2.5",
        scenarioTimeCapMs: 180000,
        scenarios: results,
      },
      null,
      2,
    ) + "\n";
  // Reserve before any provider work. A restart requires new approval and a new ledger.
  await writeFile(reportPath, report(), { flag: "wx", mode: 0o600 });
  const save = async () => {
    await writeFile(reportPath + ".tmp", report(), { mode: 0o600 });
    await rename(reportPath + ".tmp", reportPath);
  };
  await recordAttempts(
    output,
    instance,
    deps,
    results,
    cursorSdkScenarios.map((scenario) => scenario.id),
    "scenario-policy",
    save,
  );
  return results;
}

/** The owner's separate approval admits only previously skipped behavioural scenarios. */
export async function recordFullAccessCursorSdkBatch(
  output: string,
  instance: { id: string; homeDir: string },
  deps: CursorRecordingDependencies,
) {
  const reportPath = join(output, "recording-report.json");
  const report = BatchReport.parse(JSON.parse(await readFile(reportPath, "utf8")));
  if (report.fullAccessApproval || report.initialScenarios)
    throw new Error("This full-access approval has already been admitted; no retries authorized");
  if (report.scenarios.find((value) => value.scenario === "full-access")?.outcome !== "complete")
    throw new Error("The original full-access recording must already be complete");
  for (const scenario of behaviouralScenarios) {
    const prior = report.scenarios.filter((value) => value.scenario === scenario.id);
    if (prior.length !== 1 || prior[0]?.outcome !== "skipped")
      throw new Error("Behavioural approval cannot retry a previously admitted scenario");
    try {
      await access(join(output, `${scenario.id}.jsonl`));
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) continue;
      throw error;
    }
    throw new Error("A behavioural capture already exists; no retry authorized");
  }
  const approval =
    "Owner-approved 2026-10-03 continuation: 12 behavioural scenarios once in full-access, no retries";
  await writeFile(
    join(output, "full-access-approval.json"),
    JSON.stringify(
      {
        approval,
        recordingPolicy: "full-access",
        scenarios: behaviouralScenarios.map((scenario) => scenario.id),
        scenarioTimeCapMs: 180000,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  report.initialScenarios = report.scenarios.map((result) => ({ ...result }));
  report.fullAccessApproval = approval;
  const save = async () => {
    await writeFile(reportPath + ".tmp", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await rename(reportPath + ".tmp", reportPath);
  };
  await save();
  await recordAttempts(
    output,
    instance,
    deps,
    report.scenarios,
    behaviouralScenarios.map((scenario) => scenario.id),
    "full-access",
    save,
  );
  return report.scenarios;
}

async function recordAttempts(
  output: string,
  instance: { id: string; homeDir: string },
  deps: CursorRecordingDependencies,
  results: Result[],
  scenarios: readonly CursorSdkScenarioId[],
  recordingPolicy: "scenario-policy" | "full-access",
  save: () => Promise<void>,
) {
  const scrub = createRedactor({ env: deps.launchEnv, home: instance.homeDir });
  for (const scenarioId of scenarios) {
    const approval = { scenario: scenarioId, approved: true };
    const plan = cursorSdkPlan(approval, recordingPolicy);
    let result = results.find((value) => value.scenario === scenarioId);
    if (!result) {
      result = { scenario: scenarioId, outcome: "started", elapsedMs: 0 };
      results.push(result);
    }
    result.outcome = "started";
    result.elapsedMs = 0;
    result.recordingPolicy = recordingPolicy;
    delete result.reason;
    if (deps.signal.aborted) {
      result.outcome = "skipped";
      result.reason = "Batch aborted before this scenario was admitted; no prompt sent";
      await save();
      continue;
    }
    if (plan.policy === "restricted" && deps.sdk?.autoReviewAvailable !== true) {
      result.outcome = "skipped";
      result.reason = autoReviewReason;
      if (plan.requiresMcp && !deps.sdk?.mcp)
        result.reason +=
          " No thread/instance-scoped MCP lease was provisioned because the prerequisite Auto-review verification failed.";
      await save();
      process.stdout.write(`${scenarioId}: skipped\n`);
      continue;
    }
    if (plan.requiresMcp && !deps.sdk?.mcp) {
      result.outcome = "skipped";
      result.reason =
        "No real thread/instance-scoped lease factory from the MCP storage/tools owner was supplied. No turn was sent.";
      await save();
      continue;
    }
    await save();
    const started = deps.now();
    const cap = new AbortController();
    const timer = setTimeout(() => cap.abort(new Error("Scenario time cap reached")), 180000);
    try {
      await recordCursorSdkScenario(
        {
          approval,
          recordingPolicy,
          path: join(output, `${scenarioId}.jsonl`),
          instance,
          freshFixtureInstance: true,
          startedAt: new Date(started).toISOString(),
          platform: `${process.platform}-${process.arch}`,
        },
        { ...deps, signal: AbortSignal.any([deps.signal, cap.signal]) },
      );
      result.outcome = "complete";
    } catch (error) {
      result.outcome = "incomplete";
      const messages: string[] = [];
      let cause: unknown = error;
      for (let depth = 0; cause instanceof Error && depth < 4; depth++) {
        messages.push(cause.message);
        cause = cause.cause;
      }
      const safe = z
        .object({ text: z.string() })
        .parse(JSON.parse(scrub(JSON.stringify({ text: messages.join("; ") }))));
      result.reason = safe.text || "Recording failed; no retry authorized";
    } finally {
      clearTimeout(timer);
      result.elapsedMs = Math.max(0, deps.now() - started);
      await save();
    }
    process.stdout.write(`${scenarioId}: ${result.outcome}, ${result.elapsedMs} ms\n`);
  }
}
