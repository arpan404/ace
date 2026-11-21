import { z } from "zod";
import {
  BotFileV1,
  MarketEntryName,
  Recipe,
  recipeLimits,
  RecipeConnectorId,
  RecipePluginRef,
  RecipeSkillRef,
  type MarketNeed,
  type MarketProblem,
} from "@ace/protocol/marketplace";
import { inlineContractFiles } from "./contract-files.ts";
import { readPackage } from "./package.ts";
import { secretFieldNames, secretValueProblems } from "./secrets.ts";

/*
 * A bot recipe (ADR 0168 §5): ADR 0132's bot file at version 2, which asks rather than grants.
 * Version 1 files read as recipes too, their connector choices turned into needs. A recipe that
 * holds anything named or shaped like a secret is refused whole.
 */

const known = new Set([
  "format",
  "version",
  "name",
  "blurb",
  "task",
  "face",
  "model",
  "routines",
  "skills",
  "plugins",
  "needs",
  "notes",
  "personality",
]);

/** Fields only version 3 reads; on a version 2 recipe they are kept as raw data, unused. */
const v3Only = new Set([
  "requires",
  "uses",
  "triggers",
  "effects",
  "limits",
  "tests",
  "style",
  "pricing",
]);

export interface ReadRecipe {
  recipe: Recipe | undefined;
  problems: MarketProblem[];
  /** What a version 1 file couldn't bring. */
  notes: string[];
}

const path = "bot.json";
const ScheduleTrigger = z.object({ schedule: z.string().min(1).max(200) });
const AnyRecord = z.record(z.string(), z.unknown());
const Versioned = z.object({ version: z.unknown() });

function fromV1(file: z.infer<typeof BotFileV1>, notes: string[]): Recipe {
  const routines: Recipe["routines"] = [];
  for (const routine of file.routines) {
    const trigger = ScheduleTrigger.safeParse(routine.trigger);
    if (trigger.success && routine.name.trim() && routine.instruction.trim())
      routines.push({
        name: routine.name.trim(),
        instruction: routine.instruction.trim(),
        schedule: trigger.data.schedule,
      });
    else
      notes.push(
        `The routine ${routine.name || "without a name"} isn't on a schedule and was left out`,
      );
  }
  if (file.connectors?.all)
    notes.push("The bot had every connector; a recipe asks for each by name");
  const avatar = AnyRecord.safeParse(file.avatar);
  return {
    format: "spade-bot",
    version: 2,
    triggers: [],
    effects: [],
    tests: [],
    name: file.name,
    blurb: "",
    task: file.task,
    ...(avatar.success && avatar.data["kind"] === "character" ? { face: avatar.data } : {}),
    model: file.model === "fast" ? "fast" : "capable",
    routines: routines.slice(0, recipeLimits.routines),
    skills: [],
    plugins: [],
    needs: {
      connectors: (file.connectors?.connectors ?? [])
        .filter((id) => RecipeConnectorId.safeParse(id).success)
        .slice(0, recipeLimits.connectors)
        .map((id) => ({ id, why: "The bot this recipe came from used it.", required: false })),
    },
    notes: file.notes.slice(0, recipeLimits.notes),
  };
}

/**
 * `bot.json`'s text as a recipe, with every problem that refuses it. `folders` are the skill
 * folders the recipe's own archive holds (`skills/<name>` with a `SKILL.md`).
 */
export function readRecipe(
  text: string,
  folders: ReadonlySet<string> = new Set(),
  options: {
    spade?: string | undefined;
    /** The package's other files, for its contracts' schema files: a path to its text. */
    files?: ((path: string) => string | undefined) | undefined;
  } = {},
): ReadRecipe {
  const problems: MarketProblem[] = [];
  const notes: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      recipe: undefined,
      problems: [{ path, message: "bot.json isn't JSON", rule: "package.not-object" }],
      notes,
    };
  }
  for (const field of secretFieldNames(json))
    problems.push({
      path,
      message: `${field} is named like a secret; a recipe never carries one`,
      rule: "package.secret",
    });
  for (const found of secretValueProblems(text, path))
    problems.push(Object.assign(found, { rule: "package.secret" }));
  const version = Versioned.safeParse(json);
  let recipe: Recipe | undefined;
  if (version.success && version.data.version === 1) {
    const v1 = BotFileV1.safeParse(json);
    if (v1.success) recipe = fromV1(v1.data, notes);
    else problems.push(...issues(v1.error));
  } else if (version.success && version.data.version === 3) {
    // Its contracts' schema files are written in first, as Spade does (ADR 0200 §7).
    const inlined = inlineContractFiles(json, options.files ?? (() => undefined));
    problems.push(...inlined.problems.map(({ rule, message }) => ({ path, message, rule })));
    const read = readPackage(AnyRecord.parse(inlined.bot), options);
    problems.push(...read.problems);
    recipe = read.recipe;
  } else {
    // Version 2 has nothing of version 3's: those fields are only raw data here.
    const fields = AnyRecord.safeParse(json).data ?? {};
    const v2 = Recipe.safeParse(
      Object.fromEntries(Object.entries(fields).filter(([key]) => !v3Only.has(key))),
    );
    if (v2.success && v2.data.version === 2) {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) if (!known.has(key)) extra[key] = value;
      recipe = Object.keys(extra).length ? { ...v2.data, extra } : v2.data;
    } else if (v2.success)
      problems.push({ path, message: "bot.json: version is 1, 2 or 3", rule: "package.version" });
    else problems.push(...issues(v2.error));
  }
  if (recipe) problems.push(...referenceProblems(recipe, folders));
  return { recipe: problems.length ? undefined : recipe, problems, notes };
}

function issues(error: z.ZodError): MarketProblem[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path,
    message: `${issue.path.join(".") || "bot.json"}: ${issue.message}`,
  }));
}

/** A recipe names only entries of its own source, or folders it holds itself. */
function referenceProblems(recipe: Recipe, folders: ReadonlySet<string>): MarketProblem[] {
  const problems: MarketProblem[] = [];
  for (const skill of recipe.skills) {
    if (!RecipeSkillRef.safeParse(skill).success)
      problems.push({
        path,
        message: `${skill} isn't a skill of this source; a recipe can't name another source's entries`,
      });
    else if (skill.startsWith("skills/") && !folders.has(skill))
      problems.push({ path, message: `${skill} isn't a folder with a SKILL.md in this recipe` });
  }
  for (const plugin of recipe.plugins)
    if (!RecipePluginRef.safeParse(plugin).success)
      problems.push({
        path,
        message: `${plugin} isn't a plugin of this source; a recipe can't name another source's entries`,
      });
  if (new Set(recipe.skills).size !== recipe.skills.length)
    problems.push({ path, message: "A skill is named twice" });
  if (new Set(recipe.plugins).size !== recipe.plugins.length)
    problems.push({ path, message: "A plugin is named twice" });
  return problems;
}

/** The marketplace entries a recipe brings, by type and name. */
export function recipeEntries(
  recipe: Recipe,
): { type: "spade-skill" | "spade-plugin"; name: string }[] {
  return [
    ...recipe.skills
      .filter((skill) => skill.startsWith("spade-skill/"))
      .map((skill) => ({
        type: "spade-skill" as const,
        name: MarketEntryName.parse(skill.slice(12)),
      })),
    ...recipe.plugins.map((plugin) => ({
      type: "spade-plugin" as const,
      name: MarketEntryName.parse(plugin.slice(13)),
    })),
  ];
}

/** Each need as a switch: required ones start on, optional ones off (ADR 0168 §8). */
export function recipeNeeds(recipe: Recipe): MarketNeed[] {
  return [
    ...recipe.needs.connectors.map((need) =>
      "id" in need
        ? {
            key: `connector:${need.id}`,
            kind: "connector" as const,
            label: need.id,
            why: need.why,
            required: need.required,
          }
        : {
            key: `connector:${need.url}`,
            kind: "connector" as const,
            label: need.url,
            why: need.why,
            required: need.required,
          },
    ),
    ...recipe.plugins.map((plugin) => ({
      key: `plugin:${plugin.slice(13)}`,
      kind: "plugin" as const,
      label: plugin.slice(13),
      why: "The recipe brings it.",
      required: true,
    })),
  ];
}

/** The needs the person left on: their switches, else each need's default. */
export function grantedNeeds(
  needs: readonly MarketNeed[],
  switches: Readonly<Record<string, boolean>>,
): MarketNeed[] {
  return needs.filter((need) => switches[need.key] ?? need.required);
}
