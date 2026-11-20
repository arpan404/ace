import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CliBotInit, CliBotStarter } from "@ace/protocol/cli-outputs";
import { CliFailure, usageFailure } from "../output.ts";
import { scaffold, slugOf } from "./scaffold.ts";

/* `ace bot init NAME [--template T] [--path PATH]` (ADR 0200 §9): a package folder to start from. */

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
  const folder = resolve(options.cwd, options.path ?? slug);
  if (!(await isEmpty(folder)))
    throw new CliFailure("refused", `${folder} already holds files.`, undefined, {
      code: "conflict",
      hint: "Pass --path with an empty or new folder.",
    });
  const files = scaffold(trimmed, template);
  for (const file of files) {
    const target = join(folder, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text, { flag: "wx" });
  }
  return { path: folder, name: trimmed, template, files: files.map((file) => file.path) };
}

/** `ace bot init`'s lines. Pure. */
export function initLines(made: CliBotInit): string[] {
  return [
    `Made ${made.name} in ${made.path}:`,
    ...made.files.map((file) => `  ${file}`),
    `Next: cd ${made.path}, then ace bot check and ace bot test.`,
  ];
}
