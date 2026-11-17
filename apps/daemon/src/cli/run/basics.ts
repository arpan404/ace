import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { complete, completionScript, currentShell, installPlan, shells } from "../completion.ts";
import { commandJson, commandTree, helpFor } from "../help/index.ts";
import { overview } from "../help/pages.ts";
import { emit, print } from "../io.ts";
import { CliFailure, usageFailure } from "../output.ts";
import type { CommandContext, Handlers } from "./context.ts";

/** This build's version: stamped by the release, else read from the install. */
export async function versionOf(env: NodeJS.ProcessEnv): Promise<string> {
  const { cliVersion } = await import("../../doctor/install.ts");
  return cliVersion(env, process.argv[1]);
}

async function help(context: CommandContext): Promise<void> {
  const { words, flags } = context.args;
  const answer = helpFor(context.table, words);
  if (flags.schema) {
    const output = answer.command?.output;
    if (!output)
      throw new CliFailure(
        "refused",
        `ace ${words.join(" ")} has no --json schema yet.`,
        undefined,
        {
          code: "not_found",
          hint: "See what has one with ace help --json.",
        },
      );
    const [{ z }, { cliOutputs }] = await Promise.all([
      import("zod"),
      import("@ace/protocol/cli-outputs"),
    ]);
    const schema = Object.hasOwn(cliOutputs, output)
      ? cliOutputs[output as keyof typeof cliOutputs]
      : undefined;
    if (!schema) throw new CliFailure("refused", `There's no schema named ${output}.`);
    return print({ ...context.args, flags: { ...flags, json: true } }, z.toJSONSchema(schema));
  }
  if (context.mode === "json") {
    const value = answer.command
      ? commandJson(answer.command)
      : words.length === 0
        ? commandTree(context.table, await versionOf(context.env))
        : { help: answer.text };
    return print(context.args, value);
  }
  return emit(context.args, answer.text);
}

async function completion(context: CommandContext): Promise<void> {
  const word = context.args.words[0] ?? "";
  if (word === "install") {
    const shell = currentShell(context.env, process.platform);
    if (!shell)
      throw usageFailure("ace can't tell which shell you use.", {
        hint: `Print a script with ace completion ${shells.join("|")} and add it yourself.`,
      });
    const plan = installPlan(shell, homedir(), context.env);
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, completionScript(shell));
    return emit(
      context.args,
      { shell, path: plan.path },
      {
        human: () => [
          `Installed ${shell} completion in ${plan.path}.`,
          ...(plan.next ? [plan.next] : ["Open a new shell to use it."]),
        ],
        quiet: () => [plan.path],
      },
    );
  }
  const shell = shells.find((name) => name === word);
  if (!shell)
    throw usageFailure(`ace completion takes ${shells.join(", ")} or install, not ${word}.`, {
      argument: "SHELL",
    });
  process.stdout.write(completionScript(shell));
}

async function home(context: CommandContext): Promise<void> {
  if (context.args.interactive) {
    // A broken install still lands the person on the way out (ADR 0176 §13).
    const loaded = await import("../interactive/home.ts").catch(() => undefined);
    if (loaded) return loaded.interactiveHome(context);
    process.stderr.write("Something in ace is broken. Run ace doctor or ace triage.\n");
  }
  if (context.mode === "json")
    return print(context.args, commandTree(context.table, await versionOf(context.env)));
  return emit(context.args, overview(context.table));
}

export const basicHandlers: Handlers = {
  home,
  help,
  version: async (context) => {
    const version = await versionOf(context.env);
    return emit(context.args, { version }, { human: () => version, quiet: () => [version] });
  },
  completion,
  complete: async (context) => {
    process.stdout.write(
      complete(context.table, context.args.words)
        .map((word) => `${word}\n`)
        .join(""),
    );
  },
  status: async (context) => (await import("../work/status.ts")).statusCommand(context),
};
