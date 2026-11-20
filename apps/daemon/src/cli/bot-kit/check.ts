import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  breaksReason,
  contractBreaks,
  latestPublished,
  marketOrigin,
  type MarketReads,
} from "@ace/marketplace";
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
export function contractProblems(previous: unknown, bot: unknown): CliProblem[] {
  return contractBreaks(previous, bot).map((change) => ({
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
    const breaks = contractProblems(await previousOf(options.against), bot);
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

/** The market's public read routes at `origin`, as `ace bot publish` reads them: no account. */
export function marketReads(origin: string, fetcher: typeof fetch = fetch): MarketReads {
  const get = (path: string, accept: string) =>
    fetcher(new URL(path, origin), {
      headers: { accept },
      signal: AbortSignal.timeout(30_000),
    });
  return {
    read: async (path) => {
      const response = await get(path, "application/json");
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`the market answered ${response.status}`);
      return response.json();
    },
    object: async (hash) => {
      const response = await get(`/v1/objects/${hash}`, "application/x-tar");
      if (!response.ok) throw new Error(`the market answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/**
 * Refuses publishing `bot` as `name` when its contracts break the bots calling the latest
 * published version (ADR 0200 §7), read from the market itself. The market's signer refuses
 * the same change; this says so before anything uploads.
 */
export async function checkAgainstPublished(
  name: string,
  bot: unknown,
  reads: MarketReads,
): Promise<void> {
  let previous;
  try {
    previous = await latestPublished(reads, name);
  } catch (error) {
    throw new CliFailure(
      "failed",
      `Couldn't read ${name}'s published version to compare its contracts: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { code: "failed", hint: "Try again, or check it offline with --against PATH." },
    );
  }
  if (!previous) return;
  const breaks = contractProblems(previous.bot, bot);
  if (breaks.length)
    throw new CliFailure(
      "failed",
      breaksReason(previous.version, contractBreaks(previous.bot, bot)),
      { problems: breaks },
      { code: "check_failed", problems: breaks },
    );
}

/** Where `ace bot publish` reads the market: ACE_MARKET_URL for a development one. */
export const marketOf = (env: NodeJS.ProcessEnv) => env["ACE_MARKET_URL"] ?? marketOrigin;
