import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { breakingChanges, readPackage } from "@ace/marketplace";
import type { CliProblem } from "@ace/protocol/cli-output";
import type { CliBotCheck } from "@ace/protocol/cli-outputs";
import { CliFailure } from "../output.ts";
import { checkFolder } from "../market/check.ts";
import { slugOf } from "./scaffold.ts";

/*
 * `ace bot check [PATH]` (ADR 0200 §9): the market's own checks on a package folder, with the
 * reader `@ace/marketplace` shares with Spade (`readRecipe`, which must agree with
 * `spade_core::package::read`), so there is no second parser here. On top, warnings a publisher
 * should see that never refuse the package. With the version callers use (`--against`), a change
 * to a contract that breaks them refuses it: a breaking change takes a new name (ADR 0200 §7).
 */

/** Fewer words than this in an effect's `why` reads as a placeholder on the install review. */
const WHY_WORDS = 4;

/** A sentence `ace bot init --from` left for the developer to write. */
const TODO = /\bTODO\b/;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** What's worth fixing in a `bot.json` the market accepts. Pure. */
export function packageWarnings(bot: unknown): CliProblem[] {
  if (typeof bot !== "object" || bot === null) return [];
  const fields = bot as Record<string, unknown>;
  const warnings: CliProblem[] = [];
  const effects = Array.isArray(fields["effects"]) ? fields["effects"] : [];
  effects.forEach((effect: unknown, at) => {
    if (typeof effect !== "object" || effect === null) return;
    const entry = effect as Record<string, unknown>;
    const why = typeof entry["why"] === "string" ? entry["why"] : "";
    const word = typeof entry["effect"] === "string" ? entry["effect"] : "this effect";
    if (TODO.test(why))
      warnings.push({
        path: "bot.json",
        message: `effects[${at}].why still says TODO: say in a sentence what the bot does with ${word}, or take the effect out`,
      });
    else if (why.trim() && words(why) < WHY_WORDS)
      warnings.push({
        path: "bot.json",
        message: `effects[${at}].why is short: the install review shows it beside the ${word} switch, so say in a sentence what the bot does with it`,
      });
  });
  if (typeof fields["blurb"] === "string" && TODO.test(fields["blurb"]))
    warnings.push({
      path: "bot.json",
      message: "blurb still says TODO: the market shows it under the bot's name",
    });
  const tests = Array.isArray(fields["tests"]) ? fields["tests"] : [];
  if (tests.length === 0)
    warnings.push({
      path: "bot.json",
      message: "tests names no scenario: ace bot test has nothing to run, and the market runs them",
    });
  return warnings;
}

/** What `bot`'s contracts break for callers of `previous` (both `bot.json` values). Pure. */
export function contractBreaks(previous: unknown, bot: unknown): CliProblem[] {
  const contracts = (value: unknown) =>
    typeof value === "object" && value !== null
      ? (readPackage(value as Record<string, unknown>).recipe?.contracts ?? [])
      : [];
  return breakingChanges(contracts(previous), contracts(bot)).map((change) => ({
    path: "bot.json",
    message: `contracts: ${change}. A change that breaks callers takes a new contract name.`,
  }));
}

/** The `bot.json` of the version callers use: a package folder, or the file itself. */
async function previousOf(against: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  const path = resolve(against);
  const folder = await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
  return JSON.parse(await readFile(folder ? resolve(path, "bot.json") : path, "utf8"));
}

/**
 * The package's checks at `root`; a failure carrying every problem when there is one. `against`
 * is the version callers use, whose contracts this one may not break.
 */
export async function checkPackage(
  root: string,
  options: { against?: string | undefined } = {},
): Promise<CliBotCheck> {
  const folder = resolve(root);
  const name = slugOf(folder.split(/[\\/]/).findLast(Boolean) ?? "") || "package";
  const result = await checkFolder(folder, { type: "spade-bot", name });
  if (result.problems.length > 0) {
    const count = result.problems.length;
    throw new CliFailure(
      "failed",
      `${name} has ${count} problem${count === 1 ? "" : "s"} to fix.`,
      { ...result, warnings: [] },
      { code: "check_failed", problems: result.problems },
    );
  }
  const { readFile } = await import("node:fs/promises");
  const bot: unknown = JSON.parse(await readFile(resolve(folder, "bot.json"), "utf8"));
  if (options.against) {
    const breaks = contractBreaks(await previousOf(options.against), bot);
    if (breaks.length > 0)
      throw new CliFailure(
        "failed",
        `${name} would break bots that call it: ${breaks.length} change${breaks.length === 1 ? "" : "s"} to its contracts.`,
        { ...result, problems: breaks, warnings: [] },
        { code: "check_failed", problems: breaks },
      );
  }
  return {
    name,
    hash: result.hash,
    files: result.files,
    bytes: result.bytes,
    warnings: packageWarnings(bot),
  };
}

/** `ace bot check`'s lines. Pure. */
export function checkLines(checked: CliBotCheck): string[] {
  return [
    `${checked.name} passes the market's checks. ${checked.files} files, content hash ${checked.hash}.`,
    ...checked.warnings.map((warning) => `! ${warning.path ?? "bot.json"}: ${warning.message}`),
  ];
}
