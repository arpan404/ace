import type { MarketProblem } from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import { text } from "../listing.ts";
import type { Recipe } from "@ace/protocol/marketplace";
import { readRecipe } from "../recipe.ts";
import { checkSkill, folderSecretProblems, type SkillInspection } from "./skill.ts";
import { panelProblems } from "./panels.ts";

/** A recipe's facts for its review, with each skill folder it holds checked as a skill. */
export interface BotInspection {
  type: "spade-bot";
  recipe: Recipe;
  /** `skills/<name>/` folders inside the recipe, each a skill. */
  folders: { name: string; files: ArchiveFile[]; inspection: SkillInspection }[];
  notes: string[];
}

/** `bot.json`'s fields as written, for the checks that apply even when it doesn't read. */
function written(source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** What a version 3 package's folder may hold besides `bot.json` and `skills/` (ADR 0200 §3.1). */
const packageFile =
  /^(?:README\.md|assets\/[^/]+(?:\/[^/]+)*|tests\/[^/]+\.json|(?:cards|panels|contracts)\/.+)$/;

/**
 * A bot recipe or agent package: `bot.json` read at version 2 or 3, its own skill folders, no
 * secrets; a package may hold its README, assets and tests too, and no executable outside a skill.
 */
export function checkBot(
  files: readonly ArchiveFile[],
  options: { spade?: string | undefined } = {},
): {
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
  const read = readRecipe(bot, new Set(folders.map((folder) => `skills/${folder.name}`)), options);
  problems.push(...read.problems);
  // A package that doesn't read is still held to a package's rules, so all its problems show.
  const raw = written(bot);
  const packaged = (read.recipe?.version ?? raw["version"]) === 3;
  for (const file of rest) {
    if (file.path === "bot.json" || file.path === "market.json") continue;
    // A package's executables are a skill's scripts, run in the sandbox; nothing else runs.
    if (packaged && file.executable)
      problems.push({
        path: file.path,
        message: `${file.path} is executable outside skills/; a package runs code only as a skill's script or through a plugin`,
      });
    else if (!(packaged && packageFile.test(file.path)))
      problems.push({
        path: file.path,
        message: packaged
          ? `${file.path} isn't part of a package (bot.json, README.md, assets/, skills/, tests/, cards/, panels/, contracts/)`
          : `${file.path} isn't part of a recipe (bot.json and skills/<name>/ only)`,
      });
  }
  if (packaged) problems.push(...panelProblems(raw["surfaces"], rest));
  const tests =
    read.recipe?.tests ??
    (Array.isArray(raw["tests"])
      ? raw["tests"].filter((test): test is string => typeof test === "string")
      : []);
  for (const test of tests)
    if (!rest.some((file) => file.path === test))
      problems.push({ path: test, message: `${test} is named in tests but isn't in the package` });
  return read.recipe && problems.length === 0
    ? {
        inspection: { type: "spade-bot", recipe: read.recipe, folders, notes: read.notes },
        problems,
      }
    : { inspection: undefined, problems };
}
