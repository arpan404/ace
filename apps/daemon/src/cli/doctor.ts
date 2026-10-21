import { formatDoctor } from "@ace/diagnostics";
import { TriageProvider } from "@ace/protocol";
import { collectDoctorReport, fixDoctorReport } from "../diagnostics-report.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import { doctorPrompt, offerDoctorHandoff } from "./triage.ts";
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
    : { report: await collectDoctorReport(config, process.env, Date.now), repairs: [] };
  const { report, repairs } = result;
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
  if (args.flags.fix && remaining) await offerDoctorHandoff(args, report);
  if (diagnosticExit) process.exitCode = diagnosticExit;
}
