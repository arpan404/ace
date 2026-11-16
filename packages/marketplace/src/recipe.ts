import { z } from "zod";
import { MarketEntryName, type MarketNeed, type MarketProblem } from "@ace/protocol/marketplace";
import { secretFieldNames, secretValueProblems } from "./secrets.ts";

/*
 * A bot recipe (ADR 0168 §5): ADR 0132's bot file at version 2, which asks rather than grants.
 * Version 1 files read as recipes too, their connector choices turned into needs. A recipe that
 * holds anything named or shaped like a secret is refused whole.
 */

/** Spade's limit on a bot's standing task, in characters (`engine::TASK_CHARS`). */
export const recipeTaskChars = 4000;
export const recipeLimits = {
  routines: 32,
  skills: 32,
  plugins: 16,
  connectors: 32,
  notes: 50,
} as const;

const ConnectorId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const HttpsUrl = z
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "A server is named by its https address");
const why = z.string().trim().min(1).max(500);
const ConnectorNeed = z.union([
  z.strictObject({ id: ConnectorId, why, required: z.boolean().default(false) }),
  z.strictObject({ url: HttpsUrl, why, required: z.boolean().default(false) }),
]);
const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const RecipeRoutine = z.strictObject({
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(4000),
  /** A phrase or cron expression Spade's routines read (`weekdays at 8:00`). */
  schedule: z.string().trim().min(1).max(200),
});
/** A skill from the same source (`spade-skill/<name>`) or a folder in the recipe (`skills/<name>`). */
const SkillRef = z.string().regex(/^(?:spade-skill|skills)\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const PluginRef = z.string().regex(/^spade-plugin\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);

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
]);

export const Recipe = z.object({
  format: z.literal("spade-bot"),
  version: z.literal(2),
  name: z.string().trim().min(1).max(80),
  blurb: z.string().max(300).default(""),
  task: z.string().max(recipeTaskChars).default(""),
  /** The eight stored fields of Spade's face; Spade repairs an unknown value by its rules. */
  face: z.record(z.string().max(40), z.unknown()).optional(),
  model: z.enum(["fast", "capable"]).default("capable"),
  routines: z.array(RecipeRoutine).max(recipeLimits.routines).default([]),
  skills: z.array(z.string().max(80)).max(recipeLimits.skills).default([]),
  plugins: z.array(z.string().max(80)).max(recipeLimits.plugins).default([]),
  needs: z
    .strictObject({
      connectors: z.array(ConnectorNeed).max(recipeLimits.connectors).default([]),
      /** Narrows the bot's built-in tools (ADR 0161: unset means all); it never adds one. */
      tools: z.array(ToolName).max(64).optional(),
    })
    .default({ connectors: [] }),
  notes: z.array(z.string().max(2000)).max(recipeLimits.notes).default([]),
});
export type Recipe = z.infer<typeof Recipe> & { extra?: Record<string, unknown> };

/** Version 1 (ADR 0132), as an export between a person's own machines wrote it. */
const BotFileV1 = z.object({
  format: z.literal("spade-bot"),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  task: z.string().max(recipeTaskChars).default(""),
  avatar: z.unknown().optional(),
  model: z.string().max(200).nullish(),
  routines: z
    .array(
      z.object({
        name: z.string().max(120),
        instruction: z.string().max(4000),
        trigger: z.unknown(),
      }),
    )
    .max(64)
    .default([]),
  connectors: z
    .object({ all: z.boolean(), connectors: z.array(z.string().max(64)).max(64).default([]) })
    .nullish(),
  notes: z.array(z.string().max(2000)).max(200).default([]),
});

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
        .filter((id) => ConnectorId.safeParse(id).success)
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
export function readRecipe(text: string, folders: ReadonlySet<string> = new Set()): ReadRecipe {
  const problems: MarketProblem[] = [];
  const notes: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { recipe: undefined, problems: [{ path, message: "bot.json isn't JSON" }], notes };
  }
  for (const field of secretFieldNames(json))
    problems.push({ path, message: `${field} is named like a secret; a recipe never carries one` });
  problems.push(...secretValueProblems(text, path));
  const version = Versioned.safeParse(json);
  let recipe: Recipe | undefined;
  if (version.success && version.data.version === 1) {
    const v1 = BotFileV1.safeParse(json);
    if (v1.success) recipe = fromV1(v1.data, notes);
    else problems.push(...issues(v1.error));
  } else {
    const v2 = Recipe.safeParse(json);
    if (v2.success) {
      const extra: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(json as Record<string, unknown>))
        if (!known.has(key)) extra[key] = value;
      recipe = Object.keys(extra).length ? { ...v2.data, extra } : v2.data;
    } else problems.push(...issues(v2.error));
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
    if (!SkillRef.safeParse(skill).success)
      problems.push({
        path,
        message: `${skill} isn't a skill of this source; a recipe can't name another source's entries`,
      });
    else if (skill.startsWith("skills/") && !folders.has(skill))
      problems.push({ path, message: `${skill} isn't a folder with a SKILL.md in this recipe` });
  }
  for (const plugin of recipe.plugins)
    if (!PluginRef.safeParse(plugin).success)
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
