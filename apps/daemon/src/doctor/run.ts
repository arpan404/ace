import { homedir } from "node:os";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import type { Config } from "../config.ts";
import { collectDoctorReport } from "../diagnostics-report.ts";
import { planDoctorRepairs, type PlannedRepair } from "../doctor-plan.ts";
import { localDaemonState } from "../triage-context.ts";
import type { Args } from "../cli/args.ts";
import type { DoctorContext, DoctorFeature } from "./feature.ts";
import { doctorFeatures } from "./features.ts";

/** The CLI's context: real clock and files, and the local daemon only if it answers. */
export async function cliDoctorContext(config: Config, args: Args): Promise<DoctorContext> {
  const daemonState = await localDaemonState(config.dataDir);
  return {
    config,
    env: process.env,
    home: homedir(),
    platform: process.platform,
    now: Date.now,
    daemonState,
    async daemon(use) {
      if (daemonState !== "running") return undefined;
      try {
        // The client loads only when a feature asks for the daemon.
        const { connectCli } = await import("../cli/connection.ts");
        const session = await connectCli(config.dataDir, {
          ...args,
          flags: { ...args.flags, remote: "local", timeout: "10s" },
        });
        try {
          return await use(session.client, session.signal);
        } finally {
          await session.close();
        }
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Base checks plus every feature's. While ace's own daemon runs it holds the port, so the
 * "port in use" warning is expected and dropped.
 */
export async function collectFullReport(
  context: DoctorContext,
  features: readonly DoctorFeature[] = doctorFeatures,
): Promise<DiagnosticReport> {
  const extra = features.flatMap((feature) => feature.checks(context));
  const report = await collectDoctorReport(context.config, context.env, context.now, extra);
  // The person reading this is the one whose home it is; "~" reads better than a marker.
  const checks = report.checks.map((check) => ({
    ...check,
    message: check.message.replaceAll("<HOME>", "~"),
    fix: check.fix.replaceAll("<HOME>", "~"),
  }));
  return {
    ...report,
    checks:
      context.daemonState === "running" ? checks.filter((check) => check.id !== "port") : checks,
  };
}

/** Built-in repairs first, then each feature's, in feature order. */
export async function planAllRepairs(
  report: DiagnosticReport,
  context: DoctorContext,
  features: readonly DoctorFeature[] = doctorFeatures,
): Promise<PlannedRepair[]> {
  const offered = await Promise.all(
    features.map(async (feature) => (await feature.repairs?.(report, context)) ?? []),
  );
  return [...planDoctorRepairs(report, context.daemonState), ...offered.flat()];
}

/** Runs the chosen feature repairs; ids are `<feature id>.<repair>`. Built-ins are handled by the caller. */
export async function applyFeatureRepairs(
  chosen: readonly string[],
  report: DiagnosticReport,
  context: DoctorContext,
  features: readonly DoctorFeature[] = doctorFeatures,
): Promise<DiagnosticRepair[]> {
  const results: DiagnosticRepair[] = [];
  for (const id of chosen) {
    const owner = features.find((feature) => id.startsWith(`${feature.id}.`));
    if (!owner?.apply) continue;
    try {
      results.push(...(await owner.apply(id, report, context)));
    } catch (error) {
      results.push({
        id,
        status: "failed",
        message: error instanceof Error ? error.message.slice(0, 500) : "Repair failed",
      });
    }
  }
  return results;
}
