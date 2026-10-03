#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createCursorAccountDriver, discoverCursorSdk } from "@ace/adapter-cursor";
import { createRedactor } from "./redact.ts";
import { cursorSdkScenarios } from "./cursor-sdk-scenarios.ts";
import { cursorSdkPlan } from "./cursor-sdk-plan.ts";
import { recordCursorSdkScenario, type CursorRecordingDependencies } from "./cursor-sdk.ts";

const namespace = "fixtures/cursor-sdk/1.0.35/composer-2.5";
const autoReviewReason =
  "Auto-review availability could not be verified for this account/backend. SDK 1.0.35 exposes autoReview as a request option, but no public capability query confirms the backend classifier feature. No restricted turn was sent.";
type Result = {
  scenario: string;
  outcome: "started" | "complete" | "incomplete" | "skipped";
  elapsedMs: number;
  reason?: string;
};

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
  const scrub = createRedactor({ env: deps.launchEnv, home: instance.homeDir });
  for (const scenario of cursorSdkScenarios) {
    const approval = { scenario: scenario.id, approved: true };
    const plan = cursorSdkPlan(approval);
    const result: Result = { scenario: scenario.id, outcome: "started", elapsedMs: 0 };
    results.push(result);
    if (plan.policy === "restricted" && deps.sdk?.autoReviewAvailable !== true) {
      result.outcome = "skipped";
      result.reason = autoReviewReason;
      if (plan.requiresMcp && !deps.sdk?.mcp)
        result.reason +=
          " No thread/instance-scoped MCP lease was provisioned because the prerequisite Auto-review verification failed.";
      await save();
      process.stdout.write(`${scenario.id}: skipped\n`);
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
          path: join(output, `${scenario.id}.jsonl`),
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
    process.stdout.write(`${scenario.id}: ${result.outcome}, ${result.elapsedMs} ms\n`);
  }
  return results;
}

async function main() {
  z.tuple([z.literal("--owner-approved-2026-10-03")]).parse(process.argv.slice(2));
  const instance = {
    id: "cursor-fixture",
    homeDir: join(homedir(), ".ace-fixtures", "cursor-sdk"),
  };
  const launchEnv = { ...process.env };
  if (launchEnv.CURSOR_API_KEY !== undefined)
    throw new Error(
      "Fixture browser sign-in requires the SDK-owned store; remove the launch environment override",
    );
  const installation = await discoverCursorSdk();
  if (!installation.supported || installation.version !== "1.0.35")
    throw new Error(installation.error ?? "SDK 1.0.35 required");
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error("Recording interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const auth = await createCursorAccountDriver({
      launchEnv,
      stopInstance: async () => {},
    }).status(instance, lifetime.signal);
    if (auth.status !== "logged-in" || auth.source !== "sdk-store")
      throw new Error("Sign in to the fresh isolated fixture instance through the daemon first");
    // No public account/backend Auto-review capability evidence is available.
    // Never treat the SDK option itself or a forced development gate as verification.
    await recordApprovedCursorSdkBatch(
      resolve(import.meta.dirname, "../../..", namespace),
      instance,
      {
        signal: lifetime.signal,
        now: Date.now,
        id: randomUUID,
        launchEnv,
      },
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Recording failed"}\n`);
    process.exitCode = 1;
  });
