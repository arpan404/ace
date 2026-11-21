/*
 * The market's D1 bindings by what they hold (ADR 0174 §16), as names only. Kept free of the
 * Worker's types, so the test launcher other workspaces import (`@ace/market/testing`) can
 * migrate every database without Cloudflare's global types; `databases.ts` checks them against
 * the Worker's `Env`.
 */

/** A catalogue per entry type, by type name. */
export const catalogueBindingNames = {
  "spade-bot": "MARKET_BOTS",
  "spade-plugin": "MARKET_PLUGINS",
  "spade-skill": "MARKET_SKILLS",
  suit: "MARKET_SUITS",
} as const;

/** One database per shared domain. */
export const domainBindingNames = {
  publishers: "MARKET_PUBLISHERS",
  counts: "MARKET_COUNTS",
  moderation: "MARKET_MODERATION",
  lists: "MARKET_LISTS",
  orgs: "MARKET_ORGS",
} as const;
