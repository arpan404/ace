import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DiagnosticReport } from "@ace/protocol";
import {
  TriageProvider,
  buildTriageFacts,
  triageLaunchLine,
  triagePlaybook,
  triageProviders,
  type TriageFacts,
} from "@ace/diagnostics/triage";
import { collectTriageFacts } from "../triage-context.ts";
import { installedClis, runTriageHandoff, type InstalledCli } from "../triage-launch.ts";
import type { Config } from "../config.ts";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";
import type { TriageWizard } from "./triage-wizard.ts";

export const triageHelp = `ace triage [--provider claude|codex|cursor|opencode] [--print] [--json]

Starts a coding agent that helps when ace is not working. ace writes a playbook and the
facts about this computer (versions, daemon state, recent errors, where logs and data
live) to a temporary folder, then opens your installed Claude Code, Codex, Cursor CLI
or OpenCode there. The agent asks what went wrong, investigates, and asks before it
changes anything or files an issue.
--print writes the playbook and facts to stdout to paste into any agent. --json lists the files.
Works without the app or the daemon. Provider CLIs keep their own login and permissions.

ace doctor [--fix] [--dry-run] [--provider claude|codex|cursor|opencode] [--json]

Checks this computer's ace setup and lists the repairs it can make. In a terminal you
choose which to run; --fix runs the recommended ones; --dry-run changes nothing.
Reclaiming database space goes through the running local daemon. Legacy databases and
corrupt files are never rebuilt.`;

/** The two files the agent reads, in a folder that works even when ~/.ace is broken. */
export type TriageSession = {
  folder: string;
  playbookPath: string;
  factsPath: string;
  facts: TriageFacts;
  clis: InstalledCli[];
};

export async function triageCommand(
  args: Args,
  config: Config,
  problems: readonly string[] = [],
): Promise<void> {
  validateArgs(args, ["provider", "print"], 1);
  if (args.flags.remote)
    throw new CliFailure(
      "refused",
      "Triage runs on this computer. Run ace triage on the affected host.",
    );
  const providerValue = option(args, "provider");
  const provider = providerValue === undefined ? undefined : TriageProvider.parse(providerValue);
  if (!interactive(args)) {
    const session = await prepareTriage(config, { problems });
    await printSession(args, session);
    return;
  }
  await runTriage(args, config, { problems, ...(provider ? { provider } : {}) });
}

/** Interactive triage, also offered by `ace doctor` when findings remain. */
export async function runTriage(
  args: Args,
  config: Config,
  input: { problems?: readonly string[]; report?: DiagnosticReport; provider?: TriageProvider },
): Promise<void> {
  const wizard = await openWizard();
  let chosen: TriageProvider | "print" | undefined;
  let session: TriageSession;
  try {
    session = await wizard.progress("Collecting facts about this computer", "Facts collected", () =>
      prepareTriage(config, input),
    );
    wizard.summary(describe(session), "Triage");
    chosen = input.provider ?? (await chooseAgent(wizard, session.clis));
    wizard.finish(
      chosen === "print"
        ? "Paste the text below into any coding agent."
        : `Starting ${providerLabel(chosen)}. It will ask what went wrong.`,
    );
  } catch (error) {
    if (await cancelled(error)) return;
    throw error;
  } finally {
    wizard.close();
  }
  if (chosen === "print") {
    await print({ ...args, flags: {} }, pasteText(session));
    return;
  }
  process.exitCode = await runTriageHandoff(
    chosen,
    triageLaunchLine(session.playbookPath),
    process.env,
    session.folder,
  );
}

async function chooseAgent(
  wizard: TriageWizard,
  clis: readonly InstalledCli[],
): Promise<TriageProvider | "print"> {
  if (!clis.length) {
    wizard.warn("No agent CLI found. Install Claude Code, Codex, Cursor CLI or OpenCode.");
    return "print";
  }
  return wizard.choose<TriageProvider | "print">(
    "Which agent should investigate?",
    [
      ...triageProviders.map((entry) => {
        const cli = clis.find((candidate) => candidate.value === entry.value);
        return cli
          ? { value: entry.value, label: entry.label, hint: cli.version ?? cli.path }
          : { value: entry.value, label: entry.label, hint: "not installed", disabled: true };
      }),
      { value: "print", label: "Print it to paste elsewhere" },
    ],
    clis[0]?.value,
  );
}

/** Collect facts and write the playbook and facts files. Each probe is best-effort. */
export async function prepareTriage(
  config: Config,
  input: { problems?: readonly string[]; report?: DiagnosticReport },
): Promise<TriageSession> {
  const notes = [...(input.problems ?? [])];
  const clis = await installedClis(process.env).catch((error: unknown) => {
    notes.push(`Listing agent CLIs failed: ${error instanceof Error ? error.message : "failed"}`);
    return [];
  });
  const folder = await mkdtemp(join(tmpdir(), "ace-triage-"));
  const facts = await collectTriageFacts({
    dataDir: config.dataDir,
    sourceCache: join(tmpdir(), "ace-triage-source"),
    env: process.env,
    home: homedir(),
    now: Date.now(),
    cliVersion: version(),
    launchedFrom: process.argv[1] ?? "unknown",
    clis,
    problems: notes,
    ...(input.report ? { report: input.report } : {}),
  });
  const factsPath = join(folder, "FACTS.md");
  const playbookPath = join(folder, "PLAYBOOK.md");
  await writeFile(factsPath, buildTriageFacts(facts), { mode: 0o600 });
  await writeFile(playbookPath, triagePlaybook(factsPath), { mode: 0o600 });
  return { folder, playbookPath, factsPath, facts, clis };
}

async function printSession(args: Args, session: TriageSession): Promise<void> {
  await print(
    args,
    args.flags.json || args.flags.jq
      ? {
          folder: session.folder,
          playbook: session.playbookPath,
          facts: session.factsPath,
          launch: triageLaunchLine(session.playbookPath),
          agents: session.clis.map((cli) => cli.value),
        }
      : pasteText(session),
  );
}

/** Self-contained text for an agent that can't read local files. */
function pasteText(session: TriageSession): string {
  return `${triagePlaybook(session.factsPath)}\n---\n\n${buildTriageFacts(session.facts)}`;
}

function describe(session: TriageSession): string {
  const { facts } = session;
  const count = (level: "error" | "warn") =>
    facts.logs.reduce((sum, entry) => sum + (entry.level === level ? entry.count : 0), 0);
  const errors = count("error");
  const warnings = count("warn");
  return [
    `ace daemon: ${facts.daemon ?? "unknown"}`,
    `Last 24 hours: ${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
    ...(facts.findings?.length ? [`Doctor findings: ${facts.findings.length}`] : []),
    ...(facts.problems.length ? [`Couldn't check: ${facts.problems.length}`] : []),
    `Files: ${session.folder}`,
  ].join("\n");
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
export { interactive as triageInteractive };

/** The prompt library loads only for an interactive session. */
async function openWizard(): Promise<TriageWizard> {
  const { triageWizard, paint } = await import("./triage-wizard.ts");
  return triageWizard(`${paint(["bold", "inverse"], " ace triage ")} ${paint("dim", version())}`);
}

async function cancelled(error: unknown): Promise<boolean> {
  if (!(error instanceof Error)) return false;
  const { TriageCancelled } = await import("./triage-wizard.ts");
  return error instanceof TriageCancelled;
}

function providerLabel(provider: TriageProvider): string {
  return triageProviders.find((entry) => entry.value === provider)?.label ?? provider;
}
function version(): string {
  return process.env.ACE_VERSION ?? "development";
}
