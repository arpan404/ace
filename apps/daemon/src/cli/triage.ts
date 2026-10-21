import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { TriageKind, TriageProvider, type DiagnosticReport } from "@ace/protocol";
import { buildTriagePrompt, triageProviders, triageTemplates } from "@ace/diagnostics/triage";
import { collectDoctorReport } from "../diagnostics-report.ts";
import { triageLaunch } from "../triage-launch.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print, prompt as readPrompt } from "./io.ts";
import { CliFailure } from "./output.ts";
import { triageWizard } from "./triage-wizard.ts";

export const triageHelp = `ace triage [DESCRIPTION|-] [--kind bug|feature|performance|doctor] [--provider claude|codex|cursor] [--print]

With a terminal, choose a prompt template, describe the issue and review the prompt before opening a CLI.
--print, --json and --jq generate without launching. Pipe a description using -.
The wizard runs locally without a daemon. Provider CLIs keep their own login and permission settings.
ace doctor [--fix] [--provider claude|codex|cursor] [--print] [--json]
--fix repairs ace folder permissions and a missing log folder, reruns checks and offers a triage handoff for unresolved checks.`;

export async function triageCommand(args: Args, config: Config): Promise<void> {
  validateArgs(args, ["kind", "provider", "print"], 1, 2);
  if (args.flags.remote)
    throw new CliFailure(
      "refused",
      "Triage runs on this computer. Run ace triage on the affected host.",
    );
  const kindValue = option(args, "kind");
  const suppliedKind = kindValue === undefined ? undefined : TriageKind.parse(kindValue);
  const providerValue = option(args, "provider");
  const suppliedProvider =
    providerValue === undefined ? undefined : TriageProvider.parse(providerValue);
  const interactive =
    !!process.stdin.isTTY &&
    !!process.stdout.isTTY &&
    !args.flags.print &&
    !args.flags.json &&
    !args.flags.jq;
  const wizard = interactive ? triageWizard() : undefined;
  let generated: string;
  let provider = suppliedProvider;
  try {
    const kind =
      suppliedKind ?? (wizard ? await wizard.choose("Choose a prompt", triageTemplates) : "bug");
    let description =
      args.words[1] === undefined && wizard ? await wizard.describe() : await readPrompt(args, 1);
    const report = await collectDoctorReport(config, process.env, Date.now);
    for (;;) {
      generated = buildTriagePrompt({ kind, description, report, environment: environment() });
      if (!wizard) break;
      process.stderr.write(`\n${stripVTControlCharacters(generated)}\n`);
      const action = await wizard.choose("Use this prompt", [
        { value: "open", label: "Open in a CLI" },
        { value: "edit", label: "Edit the description" },
        { value: "print", label: "Print prompt and exit" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (action === "cancel") return;
      if (action === "edit") {
        description = await wizard.describe();
        continue;
      }
      if (action === "open") provider ??= await wizard.choose("Open in", triageProviders);
      else provider = undefined;
      break;
    }
  } finally {
    wizard?.close();
  }
  if (interactive && provider) await launchTriage(provider, generated);
  else
    await print(
      args,
      args.flags.json || args.flags.jq
        ? { prompt: generated, ...(provider ? { provider } : {}) }
        : generated,
    );
}
export function environment(): string {
  return `ace ${process.env.ACE_VERSION ?? "development"}; ${process.platform} ${process.arch}; Node ${process.version}`;
}
export function doctorPrompt(report: DiagnosticReport): string {
  return buildTriagePrompt({
    kind: "doctor",
    description:
      "Help me resolve the remaining ace doctor findings. Ask which optional tools I need before treating them as failures.",
    report,
    environment: environment(),
  });
}
export async function offerDoctorHandoff(args: Args, report: DiagnosticReport): Promise<void> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    args.flags.print ||
    args.flags.json ||
    args.flags.jq
  )
    return;
  const supplied = option(args, "provider");
  if (supplied) {
    await launchTriage(TriageProvider.parse(supplied), doctorPrompt(report));
    return;
  }
  const wizard = triageWizard();
  let provider: TriageProvider | "skip";
  try {
    provider = await wizard.choose("Investigate remaining checks", [
      ...triageProviders,
      { value: "skip", label: "Keep the report and exit" },
    ]);
  } finally {
    wizard.close();
  }
  if (provider !== "skip") await launchTriage(provider, doctorPrompt(report));
}
export async function launchTriage(provider: TriageProvider, prompt: string): Promise<void> {
  const launch = await triageLaunch(provider, prompt, process.env);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
      resolve();
    });
  });
}
