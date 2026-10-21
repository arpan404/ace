import { stat } from "node:fs/promises";
import { join } from "node:path";
import { TriageProvider } from "@ace/diagnostics/triage";
import type { DiagnosticRepair, DiagnosticReport } from "@ace/protocol";
import { repairDoctor } from "../doctor-repairs.ts";
import { recommendedRepairs, type DoctorRepairId, type PlannedRepair } from "../doctor-plan.ts";
import type { DoctorContext } from "../doctor/feature.ts";
import {
  applyFeatureRepairs,
  cliDoctorContext,
  collectFullReport,
  planAllRepairs,
} from "../doctor/run.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import { runTriage, triageInteractive } from "./triage.ts";

export async function doctorCommand(args: Args, config: Config): Promise<void> {
  validateArgs(args, ["fix", "dry-run", "provider", "all"], 1);
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

  const context = await cliDoctorContext(config, args);
  const runChecks = () => collectFullReport(context);
  const watched = interactive && !json;
  const before = watched ? await withSpinner(config, runChecks) : await runChecks();
  const plan = planAllRepairs(before, context);
  const format = args.flags.all ? formatAllChecks : formatChecks;
  if (!json) await print(args, format(before) + "\n\n" + describePlan(plan));

  let chosen: DoctorRepairId[] = [];
  if (!dryRun && plan.length) {
    if (args.flags.fix) chosen = recommendedRepairs(plan);
    else if (interactive) chosen = await pickRepairs(plan);
    else if (!json)
      await print(
        args,
        "\nRun in a terminal to choose repairs, or pass --fix for the recommended ones.",
      );
  } else if (dryRun && plan.length && !json) await print(args, "Dry run: nothing changed.");

  const repairs = await applyRepairs(chosen, args, before, context);
  // --fix reports what it couldn't run instead of silently skipping it.
  if (args.flags.fix && !dryRun)
    for (const repair of plan)
      if (repair.blocked)
        repairs.push({
          id: repair.id === "database" ? "sqlite.space" : repair.id,
          status: "skipped",
          message: repair.blocked,
        });
  const after = !repairs.length
    ? before
    : watched
      ? await withSpinner(config, runChecks)
      : await runChecks();
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

/** Checks can take minutes on a big database; say so instead of sitting silent. */
async function withSpinner<T>(config: Config, run: () => Promise<T>): Promise<T> {
  const bytes = await stat(join(config.dataDir, "events.sqlite")).then(
    (info) => info.size,
    () => 0,
  );
  const { wizardSession } = await import("./triage-wizard.ts");
  const message =
    bytes >= 1024 ** 3
      ? `Running checks. The integrity check reads all ${(bytes / 1024 ** 3).toFixed(1)} GB of the database, so this can take a few minutes`
      : "Running checks";
  return wizardSession().progress(message, "Checks finished", run);
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

/** Continuation lines of a multi-line message line up under the first. */
function indent(text: string): string {
  return text.replaceAll("\n", "\n     ");
}

/** Every check, passing ones included (`--all`). */
export function formatAllChecks(report: DiagnosticReport): string {
  return report.checks
    .map(
      (check) =>
        `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${indent(check.message)}` +
        (check.status !== "ok" && check.fix ? `\n     ${check.fix}` : ""),
    )
    .join("\n");
}

/** Problems first, with their fixes; passing checks are counted, not listed. */
export function formatChecks(report: DiagnosticReport): string {
  const open = report.checks.filter((check) => check.status !== "ok");
  const passed = report.checks.length - open.length;
  return [
    ...open.map(
      (check) =>
        `${check.status === "fail" ? "FAIL" : "WARN"} ${check.id}: ${indent(check.message)}` +
        (check.fix ? `\n     ${check.fix}` : ""),
    ),
    open.length
      ? `${passed} other ${passed === 1 ? "check" : "checks"} passed (ace doctor --all lists them).`
      : `All ${passed} checks passed.`,
  ].join("\n");
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
  const { wizardSession, TriageCancelled } = await import("./triage-wizard.ts");
  const wizard = wizardSession();
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
  args: Args,
  report: DiagnosticReport,
  context: DoctorContext,
): Promise<DiagnosticRepair[]> {
  const { config } = context;
  const repairs: DiagnosticRepair[] = [];
  if (chosen.includes("folders"))
    repairs.push(...(await repairDoctor(config.dataDir, report, process.getuid?.())));
  if (chosen.includes("database")) {
    // The daemon client loads only when a database repair actually runs.
    const { repairDoctorDatabase } = await import("./doctor-database.ts");
    repairs.push(...(await repairDoctorDatabase(config.dataDir, args, report)));
  }
  repairs.push(...(await applyFeatureRepairs(chosen, report, context)));
  return repairs;
}
