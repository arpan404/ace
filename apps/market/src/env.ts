export interface Env {
  /** Listings, publishers, download totals, reports and scan state (ADR 0168 §2, ADR 0173 §1). */
  MARKET: D1Database;
  /** Archives, drafts, pictures and scan reports, by prefix (ADR 0173 §1). */
  OBJECTS: R2Bucket;
  /** Reads per caller address, API and pages. Absent where no limit is configured. */
  READS?: RateLimit;
  /** Publishing writes per caller address; the signer's routes aren't limited. */
  PUBLISHES?: RateLimit;
  /** Counted downloads per caller address and hash; past it a fetch is served, not counted. */
  DOWNLOADS?: RateLimit;
  /** Anonymous abuse reports per caller address (ADR 0173 §7). */
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
