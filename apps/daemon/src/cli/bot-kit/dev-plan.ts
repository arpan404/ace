/*
 * What `ace bot dev` asks Spade for (ADR 0200 §9), decided without I/O: the development bot's
 * identity (`local/<folder>`, version `0.0.0-dev.N`), the install body, and whether a save asks
 * the person again. Pure.
 */

/** Where a development bot's link says it comes from: this machine, never listed. */
export const devSource = "local";

/** The version after `previous`: `0.0.0-dev.1`, then `.2`, and so on. */
export function nextDevVersion(previous: string | undefined): string {
  const at = /^0\.0\.0-dev\.(\d+)$/.exec(previous ?? "");
  return `0.0.0-dev.${at?.[1] ? Number(at[1]) + 1 : 1}`;
}

interface Linked {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hash: string;
}

/** The development bot already made from `name`, from `GET /v1/agents`. */
export function devBotOf(agents: unknown, name: string): Linked | undefined {
  if (typeof agents !== "object" || agents === null) return undefined;
  const list = (agents as { agents?: unknown }).agents;
  if (!Array.isArray(list)) return undefined;
  for (const agent of list) {
    const link = (agent as { package?: Record<string, unknown> } | null)?.package;
    if (link?.["source"] !== devSource || link["name"] !== name) continue;
    const { id, name: bot } = agent as { id?: unknown; name?: unknown };
    if (typeof id !== "string") continue;
    return {
      id,
      name: typeof bot === "string" ? bot : name,
      version: typeof link["version"] === "string" ? link["version"] : "",
      hash: typeof link["hash"] === "string" ? link["hash"] : "",
    };
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

/** The body of `POST /v1/agents` that installs the development bot. */
export function installBody(input: {
  readonly recipe: Recipe;
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly switches: Readonly<Record<string, boolean>>;
  readonly transaction: string;
}) {
  return {
    recipe: input.recipe,
    from_recipe: {
      source: devSource,
      name: input.name,
      version: input.version,
      transaction: input.transaction,
    },
    package: { source: devSource, name: input.name, version: input.version, hash: input.hash },
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
