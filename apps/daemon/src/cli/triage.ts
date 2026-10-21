import { homedir } from "node:os";
import { TriageKind, TriageProvider, type DiagnosticReport } from "@ace/protocol";
import {
  buildTriagePrompt,
  triageProviders,
  triageTemplate,
  triageTemplates,
  type TriageContext,
} from "@ace/diagnostics/triage";
import { collectDoctorReport } from "../diagnostics-report.ts";
import { collectTriageContext, localDaemonState } from "../triage-context.ts";
import { installedClis, runTriageHandoff, type InstalledCli } from "../triage-launch.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print, prompt as readPrompt } from "./io.ts";
import { CliFailure } from "./output.ts";
import type { TriageWizard } from "./triage-wizard.ts";

export const triageHelp = `ace triage [DESCRIPTION|-] [--kind bug|feature|performance|doctor] [--provider claude|codex|cursor|opencode] [--print]

Builds a ready-to-run prompt for a coding agent: what you describe, plus recent ace
warnings and errors, installed agent CLIs, the daemon's state and where ace keeps its
logs and data. Review it, then open it in Claude Code, Codex, Cursor CLI or OpenCode,
copy it, or print it.
--print, --json and --jq generate without launching. Pipe a description using -.
The wizard runs locally without a daemon. Provider CLIs keep their own login and permission settings.
ace doctor [--fix] [--provider claude|codex|cursor|opencode] [--print] [--json]
--fix repairs ace folders and reclaims database space through the running local daemon, reruns checks and offers a triage handoff for unresolved checks.
Legacy databases and corrupt files are not rebuilt.`;

type Gathered = { clis: InstalledCli[]; context: TriageContext; report?: DiagnosticReport };

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
  let provider = providerValue === undefined ? undefined : TriageProvider.parse(providerValue);
  const wizard = interactive(args) ? await openWizard() : undefined;
  let generated: string;
  try {
    const kind =
      suppliedKind ??
      (wizard
        ? await wizard.choose(
            "What do you need?",
            triageTemplates.map(({ value, label, hint }) => ({ value, label, hint })),
          )
        : "bug");
    const template = triageTemplate(kind);
    // Look around while the person types; it's ready by the time they finish.
    const gathering = gather(config, kind);
    gathering.catch(() => {});
    let description: string;
    let followUp = "";
    if (wizard && args.words[1] === undefined) {
      description = await wizard.ask(template.ask);
      followUp = await wizard.askOptional(template.followUp);
    } else
      description =
        kind === "doctor" && args.words[1] === undefined && process.stdin.isTTY
          ? ""
          : await readPrompt(args, 1);
    // Usually done while the person typed; show a spinner only if it isn't.
    const settled = await Promise.race([
      gathering.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    const { clis, context, report } =
      wizard && !settled
        ? await wizard.progress(
            kind === "doctor" ? "Running ace doctor" : "Reading recent logs",
            kind === "doctor" ? "Doctor finished" : "Logs read",
            () => gathering,
          )
        : await gathering;
    for (;;) {
      generated = buildTriagePrompt({
        kind,
        description,
        followUp,
        context,
        ...(report ? { report } : {}),
      });
      if (!wizard) break;
      wizard.preview(generated, summarize(generated, context, report));
      const action = await wizard.choose("Send it", [
        clis.length
          ? {
              value: "open",
              label: "Open in an agent CLI",
              hint: clis.map((c) => c.label).join(", "),
            }
          : {
              value: "open",
              label: "Open in an agent CLI",
              hint: "none installed",
              disabled: true,
            },
        { value: "copy", label: "Copy to clipboard", hint: "paste into any agent" },
        { value: "edit", label: "Edit my answers" },
        { value: "print", label: "Print and exit" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (action === "cancel") {
        wizard.finish("Nothing was sent.");
        return;
      }
      if (action === "edit") {
        description = await wizard.ask({ ...template.ask, initialValue: description });
        followUp = await wizard.askOptional({ ...template.followUp, initialValue: followUp });
        continue;
      }
      if (action === "copy") {
        const { copyToClipboard } = await import("./clipboard.ts");
        if (await copyToClipboard(generated, process.env)) {
          wizard.finish("Copied. Paste it into any agent.");
          return;
        }
        wizard.warn("No clipboard tool found. Choose Print and exit instead.");
        continue;
      }
      if (action === "open") provider ??= await chooseProvider(wizard, clis);
      else provider = undefined;
      wizard.finish(provider ? `Opening ${providerLabel(provider)}…` : "Prompt printed below.");
      break;
    }
  } catch (error) {
    if (await cancelled(error)) return;
    throw error;
  } finally {
    wizard?.close();
  }
  if (wizard && provider)
    process.exitCode = await runTriageHandoff(provider, generated, process.env);
  else
    await print(
      args,
      args.flags.json || args.flags.jq
        ? { prompt: generated, ...(provider ? { provider } : {}) }
        : generated,
    );
}

function interactive(args: Args): boolean {
  return (
    !!process.stdin.isTTY &&
    !!process.stdout.isTTY &&
    !args.flags.print &&
    !args.flags.json &&
    !args.flags.jq
  );
}

/** The prompt library loads only for an interactive session, never for other commands. */
async function openWizard(): Promise<TriageWizard> {
  const { triageWizard, paint } = await import("./triage-wizard.ts");
  return triageWizard(`${paint(["bold", "inverse"], " ace triage ")} ${paint("dim", version())}`);
}

async function cancelled(error: unknown): Promise<boolean> {
  if (!(error instanceof Error)) return false;
  const { TriageCancelled } = await import("./triage-wizard.ts");
  return error instanceof TriageCancelled;
}

async function gather(config: Config, kind: TriageKind): Promise<Gathered> {
  const [clis, report] = await Promise.all([
    installedClis(process.env),
    kind === "doctor" ? collectCliDoctorReport(config) : undefined,
  ]);
  const context = await collectTriageContext({
    dataDir: config.dataDir,
    env: process.env,
    home: homedir(),
    now: Date.now(),
    environment: environment(),
    clis,
  });
  return { clis, context, ...(report ? { report } : {}) };
}

/**
 * Doctor from the CLI. While ace's own daemon is running it holds the port, so the
 * "port in use" warning is expected and would only mislead the agent.
 */
export async function collectCliDoctorReport(config: Config): Promise<DiagnosticReport> {
  const [report, daemon] = await Promise.all([
    collectDoctorReport(config, process.env, Date.now),
    localDaemonState(config.dataDir),
  ]);
  return daemon === "running"
    ? { ...report, checks: report.checks.filter((check) => check.id !== "port") }
    : report;
}

function summarize(prompt: string, context: TriageContext, report?: DiagnosticReport): string {
  const parts = [`${prompt.split("\n").length} lines`];
  if (report) {
    const open = report.checks.filter((check) => check.status !== "ok").length;
    parts.push(open ? `${open} doctor ${open === 1 ? "finding" : "findings"}` : "doctor clean");
  }
  const count = (level: "error" | "warn") =>
    context.logs?.reduce((sum, entry) => sum + (entry.level === level ? entry.count : 0), 0) ?? 0;
  const errors = count("error");
  const warnings = count("warn");
  if (errors) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  if (!errors && !warnings) parts.push("logs clean");
  return `Prompt · ${parts.join(" · ")}`;
}

async function chooseProvider(
  wizard: TriageWizard,
  clis: readonly InstalledCli[],
): Promise<TriageProvider> {
  const first = clis[0]?.value;
  return wizard.choose(
    "Open in",
    triageProviders.map((entry) => {
      const cli = clis.find((candidate) => candidate.value === entry.value);
      return cli
        ? {
            value: entry.value,
            label: entry.label,
            hint: cli.version ?? cli.commands[0] ?? cli.value,
          }
        : { value: entry.value, label: entry.label, hint: "not installed", disabled: true };
    }),
    first,
  );
}

function providerLabel(provider: TriageProvider): string {
  return triageProviders.find((entry) => entry.value === provider)?.label ?? provider;
}
function version(): string {
  return process.env.ACE_VERSION ?? "development";
}
export function environment(): string {
  return `ace ${version()}; ${process.platform} ${process.arch}; Node ${process.version}`;
}
export function doctorPrompt(report: DiagnosticReport, context?: TriageContext): string {
  return buildTriagePrompt({
    kind: "doctor",
    description:
      "Help me resolve the remaining ace doctor findings. Ask which optional tools I need before treating them as failures.",
    report,
    context: context ?? { environment: environment() },
  });
}
export async function offerDoctorHandoff(
  args: Args,
  report: DiagnosticReport,
  config: Config,
): Promise<void> {
  if (!interactive(args)) return;
  const supplied = option(args, "provider");
  const { clis, context } = await gather(config, "bug");
  const prompt = doctorPrompt(report, context);
  if (supplied) {
    process.exitCode = await runTriageHandoff(TriageProvider.parse(supplied), prompt, process.env);
    return;
  }
  if (!clis.length) return;
  const wizard = await openWizard();
  let provider: TriageProvider | "skip";
  try {
    provider = await wizard.choose("Hand the remaining findings to an agent?", [
      ...clis.map((cli) => ({
        value: cli.value,
        label: cli.label,
        hint: cli.version ?? cli.commands[0] ?? cli.value,
      })),
      { value: "skip", label: "No, keep the report" },
    ]);
    wizard.finish(provider === "skip" ? "Report kept." : `Opening ${providerLabel(provider)}…`);
  } catch (error) {
    if (await cancelled(error)) return;
    throw error;
  } finally {
    wizard.close();
  }
  if (provider !== "skip") process.exitCode = await runTriageHandoff(provider, prompt, process.env);
}
