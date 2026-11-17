import { resolve } from "node:path";
import type { CliProblem } from "@ace/protocol/cli-output";
import { MarketEntryName, MarketEntryType } from "@ace/protocol/marketplace";
import { option, type Args } from "../args.ts";
import { emit } from "../io.ts";
import { CliFailure, usageFailure } from "../output.ts";
import { readFolder } from "./folder.ts";

/*
 * `ace market check [PATH] [--type T] [--name N]` (ADR 0176 §12.1): the checks the market runs
 * on upload, here, with no account and no daemon. Problems print under the error as
 * `path:line: sentence` and exit 1; `--json` carries them in the error's `problems`.
 */

/** The type a folder's own manifest says it is, when `--type` doesn't. */
export function typeOfFolder(paths: readonly string[]): MarketEntryType | undefined {
  const has = new Set(paths);
  if (has.has("suit.json")) return "suit";
  if (has.has("SKILL.md")) return "spade-skill";
  if (has.has("bot.json")) return "spade-bot";
  return undefined;
}

/** A problem as a publisher reads it: `SKILL.md:5: sentence`. */
export function problemLine(problem: CliProblem, fallback: string): string {
  return `${problem.path ?? fallback}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`;
}

export interface CheckResult {
  readonly type: MarketEntryType;
  readonly name: string;
  readonly hash: string;
  readonly files: number;
  readonly bytes: number;
  readonly problems: readonly CliProblem[];
}

/** The local checks on `root`, with the entry's type and name settled. */
export async function checkFolder(
  root: string,
  flags: { type?: string | undefined; name?: string | undefined },
): Promise<CheckResult> {
  const { checkFiles } = await import("@ace/marketplace/checks");
  const files = await readFolder(root);
  const type = MarketEntryType.safeParse(flags.type ?? typeOfFolder(files.map((f) => f.path)));
  if (!type.success)
    throw usageFailure(
      flags.type ? `${flags.type} isn't a market type.` : `ace can't tell what ${root} holds.`,
      { argument: "--type", hint: "Pass --type suit, spade-skill, spade-plugin or spade-bot." },
    );
  const name = flags.name ?? resolve(root).split(/[\\/]/).findLast(Boolean) ?? "";
  if (!MarketEntryName.safeParse(name).success)
    throw usageFailure(`${name} isn't an entry name.`, {
      argument: "--name",
      hint: "Pass --name with lowercase letters, digits and hyphens.",
    });
  const checked = checkFiles(type.data, name, files);
  return {
    type: type.data,
    name,
    hash: checked.hash,
    files: checked.files.length,
    bytes: checked.size,
    problems: checked.problems,
  };
}

export async function marketCheck(args: Args): Promise<void> {
  const root = args.words[0] ?? ".";
  const result = await checkFolder(root, {
    type: option(args, "type"),
    name: option(args, "name"),
  });
  if (result.problems.length === 0)
    return emit(args, result, {
      human: (value) => `${value.type}/${value.name} passes. Content hash ${value.hash}.`,
      quiet: (value) => [value.hash],
    });
  const count = result.problems.length;
  throw new CliFailure(
    "failed",
    `${result.type}/${result.name} has ${count} problem${count === 1 ? "" : "s"} to fix before publishing.`,
    result,
    { code: "check_failed", problems: result.problems },
  );
}
