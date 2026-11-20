import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliBotInit, CliBotStarter } from "@ace/protocol/cli-outputs";
import { CliFailure, usageFailure } from "../output.ts";
import { answerFailure, type SpadeExchange } from "../spade-call.ts";
import { botsNamed, draftOf, listedBots, packageFiles, type ListedBot } from "./from-bot.ts";
import { scaffold, slugOf, type ScaffoldFile } from "./scaffold.ts";

/*
 * `ace bot init NAME [--template T] [--path PATH]` (ADR 0200 §9): a package folder to start from,
 * from a template or, with `--from BOT`, from one of the person's own bots.
 */

const starters: readonly CliBotStarter[] = ["blank", "watcher", "club-member"];

async function isEmpty(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function initPackage(
  name: string,
  options: { template?: string | undefined; path?: string | undefined; cwd: string },
): Promise<CliBotInit> {
  const trimmed = name.trim();
  const slug = slugOf(trimmed);
  if (!trimmed || !slug)
    throw usageFailure("NAME must have a letter or a digit in it, like Fare watcher.", {
      argument: "NAME",
    });
  const template = (options.template ?? "blank") as CliBotStarter;
  if (!starters.includes(template))
    throw usageFailure(`${options.template} isn't a template.`, {
      argument: "--template",
      hint: `Pass --template ${starters.join(", ")}.`,
    });
  const folder = await emptyFolder(options.cwd, options.path, slug);
  const files = scaffold(trimmed, template);
  await writeAll(folder, files);
  return { path: folder, name: trimmed, template, files: files.map((file) => file.path) };
}

async function emptyFolder(cwd: string, path: string | undefined, slug: string) {
  const folder = resolve(cwd, path ?? slug);
  if (!(await isEmpty(folder)))
    throw new CliFailure("refused", `${folder} already holds files.`, undefined, {
      code: "conflict",
      hint: "Pass --path with an empty or new folder.",
    });
  return folder;
}

async function writeAll(folder: string, files: readonly ScaffoldFile[]) {
  for (const file of files) {
    const target = join(folder, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text, { flag: "wx" });
  }
}

/**
 * `ace bot init [NAME] --from BOT`: one of the person's bots as a package folder, from Spade's
 * draft of it. Only what a package carries is asked for; nothing of the bot's conversation,
 * notes or workspace is read.
 */
export async function initFromBot(
  exchange: SpadeExchange,
  wanted: string,
  options: { name?: string | undefined; path?: string | undefined; cwd: string },
): Promise<CliBotInit> {
  const listed = await exchange("GET", "/v1/agents");
  if (listed.status !== 200) throw answerFailure(listed);
  const found = botsNamed(listedBots(parsed(listed.body)), wanted);
  if (found.length === 0)
    throw new CliFailure("refused", `No bot here is called ${wanted}.`, undefined, {
      code: "not_found",
      hint: "See your bots with ace spade bots.",
    });
  if (found.length > 1)
    throw usageFailure(`More than one bot is called ${wanted}.`, {
      argument: "--from",
      hint: `Pass its id instead: ${found.map((bot) => bot.id).join(", ")}.`,
    });
  const bot = found[0] as ListedBot;
  const answer = await exchange("GET", `/v1/agents/${encodeURIComponent(bot.id)}/package-draft`);
  if (answer.status !== 200) throw answerFailure(answer);
  const draft = draftOf(parsed(answer.body));
  if (!draft) throw new CliFailure("failed", "Spade's draft of the bot didn't make sense.");
  const made = packageFiles(draft, options.name);
  const slug = slugOf(made.name) || "bot";
  const folder = await emptyFolder(options.cwd, options.path, slug);
  await writeAll(folder, made.files);
  return {
    path: folder,
    name: made.name,
    from: bot.id,
    files: made.files.map((file) => file.path),
    left_out: draft.leftOut,
  };
}

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** `ace bot init`'s lines. Pure. */
export function initLines(made: CliBotInit): string[] {
  const left = made.left_out ?? [];
  return [
    `Made ${made.name} in ${made.path}:`,
    ...made.files.map((file) => `  ${file}`),
    ...(left.length > 0 ? ["Not carried over:", ...left.map((line) => `  ${line}`)] : []),
    made.from
      ? `Next: cd ${made.path}, replace each TODO in bot.json, then ace bot check and ace bot test.`
      : `Next: cd ${made.path}, then ace bot check and ace bot test.`,
  ];
}
