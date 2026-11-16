import type { MarketProblem } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import { readRecipe, type Recipe } from "../recipe.ts";
import { checkSkill, folderSecretProblems, type SkillInspection } from "./skill.ts";

/** A recipe's facts for its review, with each skill folder it holds checked as a skill. */
export interface BotInspection {
  type: "spade-bot";
  recipe: Recipe;
  /** `skills/<name>/` folders inside the recipe, each a skill. */
  folders: { name: string; files: ArchiveFile[]; inspection: SkillInspection }[];
  notes: string[];
}

/** A bot recipe: `bot.json` read as a version 2 recipe, its own skill folders, no secrets. */
export function checkBot(files: readonly ArchiveFile[]): {
  inspection: BotInspection | undefined;
  problems: MarketProblem[];
} {
  const problems: MarketProblem[] = [];
  const grouped = new Map<string, ArchiveFile[]>();
  const rest: ArchiveFile[] = [];
  for (const file of files) {
    const match = /^skills\/([^/]+)\/(.+)$/.exec(file.path);
    if (match?.[1] && match[2]) {
      const list = grouped.get(match[1]) ?? [];
      list.push({ ...file, path: match[2] });
      grouped.set(match[1], list);
    } else rest.push(file);
  }
  const folders: BotInspection["folders"] = [];
  for (const [name, list] of grouped) {
    const checked = checkSkill(name, list, `skills/${name}/`);
    problems.push(...checked.problems);
    if (checked.inspection) folders.push({ name, files: list, inspection: checked.inspection });
  }
  problems.push(...folderSecretProblems(rest.filter((file) => file.path !== "bot.json")));
  const bot = text(files.find((file) => file.path === "bot.json")?.content);
  if (bot === undefined) {
    problems.push({ path: "bot.json", message: "bot.json is missing or isn't text" });
    return { inspection: undefined, problems };
  }
  const read = readRecipe(bot, new Set(folders.map((folder) => `skills/${folder.name}`)));
  problems.push(...read.problems);
  for (const file of rest)
    if (file.path !== "bot.json" && file.path !== "market.json")
      problems.push({
        path: file.path,
        message: `${file.path} isn't part of a recipe (bot.json and skills/<name>/ only)`,
      });
  return read.recipe && problems.length === 0
    ? {
        inspection: { type: "spade-bot", recipe: read.recipe, folders, notes: read.notes },
        problems,
      }
    : { inspection: undefined, problems };
}
