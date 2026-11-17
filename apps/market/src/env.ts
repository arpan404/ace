export interface Env {
  /*
   * D1, one database per entry type and per shared domain (ADR 0174 §16). Read them through
   * `store/databases.ts`, never by binding name.
   */
  /** The catalogue of `suit` entries. */
  MARKET_SUITS: D1Database;
  /** The catalogue of `spade-skill` entries. */
  MARKET_SKILLS: D1Database;
  /** The catalogue of `spade-plugin` entries. */
  MARKET_PLUGINS: D1Database;
  /** The catalogue of `spade-bot` recipes. */
  MARKET_BOTS: D1Database;
  /** Publishers, handles, verification, drafts, limits, the quota ledger and pictures. */
  MARKET_PUBLISHERS: D1Database;
  /** Download totals and buckets, trending, top publishers and the daily size record. */
  MARKET_COUNTS: D1Database;
  /** Abuse reports, appeals and the blocklist. */
  MARKET_MODERATION: D1Database;
  /** The withdrawn list, categories, featured and collections. */
  MARKET_LISTS: D1Database;
  /** Archives, drafts, pictures and scan reports, by prefix (ADR 0174 §1). */
  OBJECTS: R2Bucket;
  /** Reads per caller address, API and pages. Absent where no limit is configured. */
  READS?: RateLimit;
  /** Publishing writes per caller address; the signer's routes aren't limited. */
  PUBLISHES?: RateLimit;
  /** Counted downloads per caller address and hash; past it a fetch is served, not counted. */
  DOWNLOADS?: RateLimit;
  /** Anonymous abuse reports per caller address (ADR 0174 §7). */
  REPORTS?: RateLimit;
  /** The market's public keys as a JSON `MarketKeySet`: signer uploads must verify with one. */
  MARKET_PUBLIC_KEYS?: string;
  /** The signer's bearer token (a secret). Unset, the signer routes refuse every request. */
  MARKET_SIGNER_TOKEN?: string;
  /** The account backend's grant keys as a JSON `GrantKeySet`; set in tests and staging. */
  ACE_GRANT_KEYS?: string;
  /** Where the grant keys are read when ACE_GRANT_KEYS is unset. */
  ACE_ACCOUNT_KEYS_URL?: string;
  /** The `iss` a market grant must name; `cloud.acehq.dev` when unset. */
  ACE_GRANT_ISSUER?: string;
}
