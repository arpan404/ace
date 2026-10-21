import { formatDoctor } from "@ace/diagnostics";
import { TriageProvider } from "@ace/diagnostics/triage";
import { fixDoctorReport } from "../diagnostics-report.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import { localDaemonState } from "../triage-context.ts";
import { collectCliDoctorReport, doctorPrompt, offerDoctorHandoff } from "./triage.ts";
import { repairDoctorDatabase } from "./doctor-database.ts";
export async function doctorCommand(args: Args, config: Config): Promise<void> {
  validateArgs(args, ["fix", "provider", "print"], 1);
  if (args.flags.remote)
    throw new CliFailure(
      "refused",
      "Doctor runs on this computer. Run ace doctor on the affected host.",
    );
  const provider = option(args, "provider");
  if (provider) TriageProvider.parse(provider);
  if (provider && !args.flags.fix)
    throw new CliFailure("refused", "Use --fix with --provider for a diagnostic handoff.");
  const result = args.flags.fix
    ? await fixDoctorReport(config, process.env, Date.now, {
        repairDatabase: (report) => repairDoctorDatabase(config.dataDir, args, report),
      })
    : { report: await collectCliDoctorReport(config), repairs: [] };
  const { repairs } = result;
  // ace's own running daemon holds the port; that warning is expected, not a finding.
  const report =
    args.flags.fix && (await localDaemonState(config.dataDir)) === "running"
      ? { ...result.report, checks: result.report.checks.filter((check) => check.id !== "port") }
      : result.report;
  const remaining = report.checks.some((check) => check.status !== "ok");
  process.exitCode =
    report.checks.some((check) => check.status === "fail") ||
    repairs.some((repair) => repair.status === "failed")
      ? 1
      : 0;
  const prompt = args.flags.fix && remaining ? doctorPrompt(report) : undefined;
  if (args.flags.json || args.flags.jq)
    await print(args, {
      ...report,
      ...(args.flags.fix ? { repairs, ...(prompt ? { prompt } : {}) } : {}),
    });
  else {
    await print(
      args,
      formatDoctor(report).trimEnd() +
        (repairs.length
          ? "\n\n" +
            repairs
              .map((repair) => `${repair.status.toUpperCase()} ${repair.id}: ${repair.message}`)
              .join("\n")
          : "") +
        (remaining
          ? "\n\nInvestigate with ace triage --kind doctor, or run ace doctor --fix."
          : ""),
    );
    if (args.flags.print && prompt) await print(args, prompt);
  }
  const diagnosticExit = process.exitCode;
  if (args.flags.fix && remaining) await offerDoctorHandoff(args, report, config);
  if (diagnosticExit) process.exitCode = diagnosticExit;
}
