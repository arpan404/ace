import { readConfig, type Config } from "../config.ts";
import type { Args } from "./args.ts";
import { commandTable } from "./commands/table.ts";
import type { ArgSpec, CommandSpec } from "./commands/spec.ts";
import { aliasOutcome } from "./deprecation.ts";
import { reportFailure } from "./failure.ts";
import { nounPage } from "./help/pages.ts";
import { canPrompt, outputMode, type Surroundings } from "./input-mode.ts";
import { emit, validateOutput } from "./io.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { parseCommandLine, type Parsed } from "./parse.ts";
import { agentShell, marketPersonOnly, personOnlyRefusal } from "./person-gate.ts";
import type { CommandContext } from "./run/context.ts";
import { handlers } from "./run/index.ts";

/** The terminal and environment a run sees; tests pass their own. */
export interface Terminal extends Surroundings {
  readonly stderrTTY: boolean;
}

export function processTerminal(flags: Readonly<Record<string, string | true>>): Terminal {
  return {
    flags,
    env: process.env,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    stderrTTY: process.stderr.isTTY === true,
  };
}

/**
 * One run of `ace` (ADR 0176): read the line against the command table, then run the one
 * command it names. Every failure leaves through `reportFailure`, with its exit code.
 */
export async function main(input: readonly string[]): Promise<void> {
  const table = commandTable();
  const parsed = parseCommandLine(table, input);
  // A line that didn't parse still answers in JSON when --json was anywhere on it.
  let args: Args = {
    words: [],
    flags: { ...parsed.flags, ...(input.includes("--json") ? { json: true as const } : {}) },
  };
  let command: CommandSpec | undefined;
  try {
    if (parsed.kind === "usage")
      throw usageFailure(parsed.message, {
        code: parsed.code,
        ...(parsed.hint ? { hint: parsed.hint } : {}),
        ...(parsed.argument ? { argument: parsed.argument } : {}),
      });
    if (parsed.kind === "noun") {
      if (parsed.flags.help || outputMode(parsed.flags) !== "json")
        return await emit(args, nounPage(table, parsed.words));
      return await emit(args, { help: nounPage(table, parsed.words) });
    }
    command = parsed.command;
    const terminal = processTerminal(parsed.flags);
    args = {
      words: [...parsed.words],
      flags: { ...parsed.flags },
      lists: parsed.lists,
      interactive: canPrompt(terminal),
    };
    const helpOrVersion = earlyAnswer(parsed);
    if (helpOrVersion) command = table.byId.get(helpOrVersion.id) ?? command;
    else await checkAlias(parsed, terminal);
    // The person's alone: refused in an agent's shell, and an answer needs a terminal.
    // A market action that is the person's, from an agent's shell with no thread to ask in.
    const kind =
      command.personOnly ??
      (marketPersonOnly(command.id) && !process.env.ACE_THREAD_ID?.trim() ? "market" : undefined);
    if (kind && !helpOrVersion) {
      const refused = personOnlyRefusal(kind, {
        agent: agentShell(process.env),
        interactive: args.interactive === true,
      });
      if (refused) throw refused;
    }
    await validateOutput(args);
    if (!helpOrVersion && parsed.missing.length)
      args = { ...args, words: await fillMissing(parsed, args) };
    const context: CommandContext = {
      command,
      parsed,
      args: helpOrVersion ? { ...args, words: helpOrVersion.words } : args,
      mode: outputMode(args.flags),
      env: process.env,
      table,
      config: () => readConfigOnce(),
    };
    const handler = handlers[command.id];
    if (!handler)
      throw new CliFailure(
        "refused",
        `ace ${command.words.join(" ")} isn't built yet.`,
        undefined,
        {
          code: "not_found",
          hint: "See what works today with ace help.",
        },
      );
    await handler(context);
  } catch (error) {
    await reportFailure(args, error, command?.id);
  }
}

/** `--help` and `--version` answer before anything runs, whatever command they follow. */
function earlyAnswer(parsed: Parsed): { id: string; words: string[] } | undefined {
  // `ace thread --help` is the noun's page, not its default command's (ADR 0176 §5).
  if (parsed.flags.help && parsed.command.id !== "help")
    return {
      id: "help",
      words: [
        ...(parsed.typed.length < parsed.command.words.length && !parsed.alias
          ? parsed.typed
          : parsed.command.words),
      ],
    };
  if ((parsed.flags.version || parsed.flags.V) && parsed.command.id === "home")
    return { id: "version", words: [] };
  return undefined;
}

async function checkAlias(parsed: Parsed, terminal: Terminal): Promise<void> {
  if (!parsed.alias?.deprecatedSince) return;
  const { versionOf } = await import("./run/basics.ts");
  const outcome = aliasOutcome(
    parsed.alias,
    parsed.typed,
    parsed.command,
    await versionOf(terminal.env),
    {
      human: outputMode(parsed.flags) === "human",
      stderrTTY: terminal.stderrTTY,
    },
  );
  if (outcome.kind === "notice") process.stderr.write(`${outcome.text}\n`);
  if (outcome.kind === "refuse")
    throw usageFailure(outcome.text, { code: outcome.code, hint: outcome.hint });
}

/**
 * Asks a person for a missing argument; anywhere else it is a usage error naming it, so
 * nothing ever waits for input nobody can give (ADR 0176 §9).
 */
async function fillMissing(parsed: Parsed, args: Args): Promise<string[]> {
  const usage = `ace ${parsed.command.words.join(" ")}`;
  const first: ArgSpec | undefined = parsed.missing[0];
  if (!args.interactive || !first)
    throw usageFailure(`${usage} needs ${parsed.missing.map((arg) => arg.name).join(" and ")}.`, {
      code: "missing_argument",
      argument: first?.name ?? "",
      hint: `${first?.summary ?? "Pass it"}: ${usage} ${parsed.missing.map((arg) => arg.name).join(" ")}.`,
    });
  const { askText } = await import("./ask.ts");
  const words = [...args.words];
  const all = parsed.command.args ?? [];
  for (const [index, arg] of all.entries())
    if (words[index] === undefined && arg.required)
      words[index] = await askText(arg.summary, `Or pass it: ${usage} ${arg.name}`);
  return words;
}

let config: Config | undefined;
function readConfigOnce(): Config {
  config ??= readConfig();
  return config;
}
