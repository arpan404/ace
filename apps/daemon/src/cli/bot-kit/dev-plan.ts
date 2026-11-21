import { createHash } from "node:crypto";

/*
 * What `ace bot dev` asks Spade for (ADR 0200 §9), decided without I/O: which bot is the
 * development bot, the install body, and whether a save asks the person again. Pure.
 */

/** Where a development bot's link says it comes from: this machine, never listed. */
export const devSource = "local";

/** What a development bot's `from_recipe.version` says: made by `ace bot dev`. */
export const devVersion = "dev";

/**
 * The folder a development bot belongs to, as its `from_recipe.name` keeps it: the folder's
 * name and a digest of its full path. The bot is found by this, never by the manifest's name, so
 * renaming the bot in `bot.json` updates the same bot; another folder is another bot.
 */
export function devFolderKey(path: string): string {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? "";
  const slug = base
    .replace(/[^A-Za-z0-9]/g, "-")
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .join("-")
    .slice(0, 60);
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
  return `${slug || "bot"}@${digest}`;
}

interface Linked {
  readonly id: string;
  readonly name: string;
}

/** The development bot of the folder `key` ({@link devFolderKey}), from `GET /v1/agents`. */
export function devBotOf(agents: unknown, key: string): Linked | undefined {
  if (typeof agents !== "object" || agents === null) return undefined;
  const list = (agents as { agents?: unknown }).agents;
  if (!Array.isArray(list)) return undefined;
  for (const agent of list) {
    const from = (agent as { from_recipe?: Record<string, unknown> } | null)?.from_recipe;
    if (from?.["source"] !== devSource || from["version"] !== devVersion || from["name"] !== key)
      continue;
    const { id, name } = agent as { id?: unknown; name?: unknown };
    if (typeof id !== "string") continue;
    return { id, name: typeof name === "string" ? name : "" };
  }
  return undefined;
}

type Recipe = Record<string, unknown>;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Each declared effect as the review reads it: `network: Reads fares.` */
export function effectLines(recipe: Recipe): string[] {
  return list(recipe["effects"]).map(
    (effect) => `${String(field(effect, "effect"))}: ${String(field(effect, "why") ?? "")}`,
  );
}

/** Every declared effect's switch, on: the developer is the person and said yes to the review. */
export function allOn(keys: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

/**
 * The body of `POST /v1/agents` that installs the development bot. It claims no identity: with no
 * market signature Spade links it to the local package of its name (ADR 0200 §3.2).
 */
export function installBody(input: {
  readonly recipe: Recipe;
  /** The folder it belongs to ({@link devFolderKey}), kept with the bot as where it came from. */
  readonly folder: string;
  readonly switches: Readonly<Record<string, boolean>>;
  readonly transaction: string;
  /** Its panels' pages by path (ADR 0200 §5.2), sent beside the manifest. */
  readonly pages?: Readonly<Record<string, string>>;
}) {
  return {
    recipe: input.recipe,
    from_recipe: {
      source: devSource,
      name: input.folder,
      version: devVersion,
      transaction: input.transaction,
    },
    grants: { connectors: [], plugins: [], skills: [] },
    switches: input.switches,
    start_routines: false,
    ...(input.pages && Object.keys(input.pages).length > 0 ? { pages: input.pages } : {}),
  };
}

const kinds = (recipe: Recipe) =>
  new Set(list(recipe["triggers"]).map((trigger) => String(field(trigger, "kind"))));
const apps = (recipe: Recipe) =>
  new Set(
    list(field(recipe["needs"], "connectors")).map((need) =>
      String(field(need, "id") ?? field(need, "url")),
    ),
  );

const contracts = (recipe: Recipe) =>
  new Set(list(recipe["contracts"]).map((contract) => String(field(contract, "name"))));

/**
 * What a save asks for that the bot didn't have: the effects Spade's plan says start off, and
 * the trigger kinds, contracts (calls other bots may make to it) and apps the last applied
 * manifest didn't name. Empty when it may apply
 * without asking.
 */
export function asksMore(
  plan: unknown,
  before: Recipe | undefined,
  after: Recipe,
): { effects: string[]; more: string[] } {
  const effects = list(field(field(plan, "plan"), "asks_more")).map(String);
  const more: string[] = [];
  if (before) {
    const was = kinds(before);
    for (const kind of kinds(after)) if (!was.has(kind)) more.push(`a ${kind} trigger`);
    const had = apps(before);
    for (const app of apps(after)) if (!had.has(app)) more.push(`the app ${app}`);
    const offered = contracts(before);
    for (const name of contracts(after))
      if (!offered.has(name)) more.push(`the contract ${name}, which your other bots may call`);
  }
  return { effects, more };
}
