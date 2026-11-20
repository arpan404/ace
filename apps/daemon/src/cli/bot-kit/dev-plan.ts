/*
 * What `ace bot dev` asks Spade for (ADR 0200 §9), decided without I/O: which bot is the
 * development bot, the install body, and whether a save asks the person again. Pure.
 */

/** Where a development bot's link says it comes from: this machine, never listed. */
export const devSource = "local";

/**
 * The package a development bot is linked to: Spade's local identity for a version 3 package
 * installed without the market's signature (`envelope::local`), `local/` and the manifest's name
 * in lowercase ASCII letters and digits joined by hyphens.
 */
export function localPackageName(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9]/g, "-")
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .join("-");
  return `local/${slug || "bot"}`;
}

interface Linked {
  readonly id: string;
  readonly name: string;
}

/** The development bot already linked to package `name`, from `GET /v1/agents`. */
export function devBotOf(agents: unknown, name: string): Linked | undefined {
  if (typeof agents !== "object" || agents === null) return undefined;
  const list = (agents as { agents?: unknown }).agents;
  if (!Array.isArray(list)) return undefined;
  for (const agent of list) {
    const link = (agent as { package?: Record<string, unknown> } | null)?.package;
    if (link?.["source"] !== devSource || link["name"] !== name) continue;
    const { id, name: bot } = agent as { id?: unknown; name?: unknown };
    if (typeof id !== "string") continue;
    return { id, name: typeof bot === "string" ? bot : name };
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
  /** The folder's name, as the bot records where it came from. */
  readonly folder: string;
  readonly switches: Readonly<Record<string, boolean>>;
  readonly transaction: string;
}) {
  return {
    recipe: input.recipe,
    from_recipe: {
      source: devSource,
      name: input.folder,
      version: "dev",
      transaction: input.transaction,
    },
    grants: { connectors: [], plugins: [], skills: [] },
    switches: input.switches,
    start_routines: false,
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

/**
 * What a save asks for that the bot didn't have: the effects Spade's plan says start off, and
 * the trigger kinds and apps the last applied manifest didn't name. Empty when it may apply
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
  }
  return { effects, more };
}
