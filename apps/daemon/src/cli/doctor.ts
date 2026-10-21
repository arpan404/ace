import { formatDoctor } from "@ace/diagnostics";
import { TriageProvider } from "@ace/diagnostics/triage";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import { collectDoctorReport } from "../diagnostics-report.ts";
import { repairDoctor } from "../doctor-repairs.ts";
import {
  planDoctorRepairs,
  recommendedRepairs,
  type DoctorRepairId,
  type PlannedRepair,
} from "../doctor-plan.ts";
import { localDaemonState } from "../triage-context.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import { runTriage, triageInteractive } from "./triage.ts";

export async function doctorCommand(args: Args, config: Config): Promise<void> {
  validateArgs(args, ["fix", "dry-run", "provider"], 1);
  if (args.flags.remote)
    throw new CliFailure(
      "refused",
      "Doctor runs on this computer. Run ace doctor on the affected host.",
    );
  const providerValue = option(args, "provider");
  const provider = providerValue === undefined ? undefined : TriageProvider.parse(providerValue);
  const dryRun = !!args.flags["dry-run"];
  const json = !!(args.flags.json || args.flags.jq);
  const interactive = triageInteractive(args);

  const daemon = await localDaemonState(config.dataDir);
  const before = await cliDoctorReport(config, daemon);
  const plan = planDoctorRepairs(before, daemon);
  if (!json) await print(args, formatDoctor(before).trimEnd() + "\n\n" + describePlan(plan));

  let chosen: DoctorRepairId[] = [];
  if (!dryRun && plan.length) {
    if (args.flags.fix) chosen = recommendedRepairs(plan);
    else if (interactive) chosen = await pickRepairs(plan);
    else if (!json)
      await print(
        args,
        "Run in a terminal to choose repairs, or pass --fix for the recommended ones.",
      );
  } else if (dryRun && plan.length && !json) await print(args, "Dry run: nothing changed.");

  const repairs = await applyRepairs(chosen, config, args, before);
  // --fix reports what it couldn't run instead of silently skipping it.
  if (args.flags.fix && !dryRun)
    for (const repair of plan)
      if (repair.blocked)
        repairs.push({
          id: repair.id === "database" ? "sqlite.space" : repair.id,
          status: "skipped",
          message: repair.blocked,
        });
  const after = repairs.length ? await cliDoctorReport(config, daemon) : before;
  const remaining = after.checks.filter((check) => check.status !== "ok");
  process.exitCode =
    after.checks.some((check) => check.status === "fail") ||
    repairs.some((repair) => repair.status === "failed")
      ? 1
      : 0;

  if (json) {
    await print(args, { ...after, planned: plan, repairs });
    return;
  }
  if (repairs.length) {
    await print(
      args,
      repairs
        .map((repair) => `${repair.status.toUpperCase()} ${repair.id}: ${repair.message}`)
        .join("\n") +
        (remaining.length
          ? `\n\n${remaining.length} ${remaining.length === 1 ? "check still needs" : "checks still need"} attention.`
          : "\n\nAll checks pass."),
    );
  }
  if (!remaining.length || !interactive) return;
  const exit = process.exitCode;
  if (provider || (await wantsAgent()))
    await runTriage(args, config, { report: after, ...(provider ? { provider } : {}) });
  // A clean agent session doesn't make the remaining findings go away.
  if (exit) process.exitCode = exit;
}

/**
 * Doctor from the CLI. While ace's own daemon is running it holds the port, so the
 * "port in use" warning is expected and would only mislead.
 */
async function cliDoctorReport(
  config: Config,
  daemon: "running" | "stopped",
): Promise<DiagnosticReport> {
  const report = await collectDoctorReport(config, process.env, Date.now);
  return daemon === "running"
    ? { ...report, checks: report.checks.filter((check) => check.id !== "port") }
    : report;
}

function describePlan(plan: readonly PlannedRepair[]): string {
  if (!plan.length) return "Nothing to repair.";
  return (
    "Repairs:\n" +
    plan
      .map(
        (repair) =>
          `  ${repair.title}${repair.blocked ? " (can't run now)" : repair.recommended ? " (recommended)" : ""}\n` +
          `    ${repair.blocked ?? repair.detail}`,
      )
      .join("\n")
  );
}

async function pickRepairs(plan: readonly PlannedRepair[]): Promise<DoctorRepairId[]> {
  const { triageWizard, paint, TriageCancelled } = await import("./triage-wizard.ts");
  const runnable = plan.filter((repair) => !repair.blocked);
  if (!runnable.length) return [];
  const wizard = triageWizard(paint(["bold", "inverse"], " ace doctor "));
  try {
    const chosen = await wizard.pickMany(
      "Choose repairs to run",
      runnable.map((repair) => ({
        value: repair.id,
        label: repair.title,
        ...(repair.recommended ? { hint: "recommended" } : {}),
      })),
      recommendedRepairs(runnable),
    );
    wizard.finish(chosen.length ? "Running repairs…" : "Nothing changed.");
    return chosen;
  } catch (error) {
    if (error instanceof TriageCancelled) return [];
    throw error;
  } finally {
    wizard.close();
  }
}

async function wantsAgent(): Promise<boolean> {
  const { triageWizard, paint, TriageCancelled } = await import("./triage-wizard.ts");
  const wizard = triageWizard(paint(["bold", "inverse"], " ace doctor "));
  try {
    const answer = await wizard.choose("Start an agent to investigate what's left?", [
      { value: "yes", label: "Yes, start ace triage" },
      { value: "no", label: "No, keep the report" },
    ]);
    if (answer === "no") wizard.finish("Report kept.");
    return answer === "yes";
  } catch (error) {
    if (error instanceof TriageCancelled) return false;
    throw error;
  } finally {
    wizard.close();
  }
}

async function applyRepairs(
  chosen: readonly DoctorRepairId[],
  config: Config,
  args: Args,
  report: DiagnosticReport,
): Promise<DiagnosticRepair[]> {
  const repairs: DiagnosticRepair[] = [];
  if (chosen.includes("folders"))
    repairs.push(...(await repairDoctor(config.dataDir, report, process.getuid?.())));
  if (chosen.includes("database")) {
    // The daemon client loads only when a database repair actually runs.
    const { repairDoctorDatabase } = await import("./doctor-database.ts");
    repairs.push(...(await repairDoctorDatabase(config.dataDir, args, report)));
  }
  return repairs;
}
