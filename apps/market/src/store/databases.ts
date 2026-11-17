import type { MarketEntryType } from "@ace/protocol/marketplace";
import type { Env } from "../env.ts";

/*
 * Which D1 database holds what (ADR 0174 §16): a catalogue per entry type, and one database per
 * shared domain. Store modules take the one database they need; only this module reads the
 * bindings. A new type is a binding, an entry in `catalogueBindings` and a database created
 * from `migrations/catalogue`.
 */

/**
 * The entry types the market has a catalogue for, in the order fan-outs read and merge them:
 * by type name, so merged lists keep the order one `ORDER BY type` gave.
 */
export const catalogueBindings = {
  "spade-bot": "MARKET_BOTS",
  "spade-plugin": "MARKET_PLUGINS",
  "spade-skill": "MARKET_SKILLS",
  suit: "MARKET_SUITS",
} as const satisfies Partial<Record<MarketEntryType, keyof Env>>;

export type CatalogueType = keyof typeof catalogueBindings;
export const catalogueTypes = Object.keys(catalogueBindings) as CatalogueType[];

export const domainBindings = {
  publishers: "MARKET_PUBLISHERS",
  counts: "MARKET_COUNTS",
  moderation: "MARKET_MODERATION",
  lists: "MARKET_LISTS",
} as const satisfies Record<string, keyof Env>;

export type Domain = keyof typeof domainBindings;

/** Whether the market has a catalogue for `type`: `ace-plugin` waits for its own ADR. */
export const isCatalogued = (type: string): type is CatalogueType =>
  Object.hasOwn(catalogueBindings, type);

export interface Catalogue {
  type: CatalogueType;
  db: D1Database;
}

export interface Databases {
  /** The catalogue holding `type`'s entries, or undefined for a type the market doesn't hold. */
  catalogue(type: string): D1Database | undefined;
  /** Every catalogue, for reads that fan out; in `catalogueTypes` order. */
  catalogues: readonly Catalogue[];
  publishers: D1Database;
  counts: D1Database;
  moderation: D1Database;
  lists: D1Database;
}

export type DatabaseBindings = Pick<
  Env,
  (typeof catalogueBindings)[CatalogueType] | (typeof domainBindings)[Domain]
>;

export function databases(env: DatabaseBindings): Databases {
  const catalogues = catalogueTypes.map((type) => ({ type, db: env[catalogueBindings[type]] }));
  const byType = new Map<string, D1Database>(catalogues.map((entry) => [entry.type, entry.db]));
  return {
    catalogue: (type) => byType.get(type),
    catalogues,
    publishers: env.MARKET_PUBLISHERS,
    counts: env.MARKET_COUNTS,
    moderation: env.MARKET_MODERATION,
    lists: env.MARKET_LISTS,
  };
}

/** Runs `read` on every catalogue in parallel: one query each, as many as there are types. */
export function eachCatalogue<T>(
  dbs: Pick<Databases, "catalogues">,
  read: (catalogue: Catalogue, index: number) => Promise<T>,
): Promise<T[]> {
  return Promise.all(dbs.catalogues.map((catalogue, index) => read(catalogue, index)));
}

/** `eachCatalogue`, flattened. */
export async function fromCatalogues<T>(
  dbs: Pick<Databases, "catalogues">,
  read: (catalogue: Catalogue) => Promise<readonly T[]>,
): Promise<T[]> {
  return (await eachCatalogue(dbs, read)).flat();
}
