import type { RelayObject } from "./relay-object.ts";

export interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  /** Account and machine-directory database (ADR 0111). */
  ACCOUNTS: D1Database;
  /** Upgrade rate limit per client address. Absent where no limit is configured. */
  UPGRADES?: RateLimit;
  /** Account API request rate limit per client address. */
  ACCOUNT_REQUESTS?: RateLimit;
  /** Forwarded HTTP (`/m/<hostId>/…`, ADR 0117) per caller address. */
  HTTP_REQUESTS?: RateLimit;
  /** Forwarded HTTP per machine, keyed by host id. */
  HTTP_HOST_REQUESTS?: RateLimit;
  ACE_ACCOUNT_PUBLIC_URL?: string;
  ACE_ACCOUNT_ALLOWED_ORIGINS?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_API_KEY?: string;
  /** WorkOS API origin; tests point it at a local fake. Defaults to https://api.workos.com. */
  WORKOS_API_URL?: string;
  ACE_ACCOUNT_ENCRYPTION_KEY?: string;
  ACE_GRANT_KEY?: string;
  /** The replaced key's `/v1/keys` entry, `<id>:<public key>`, during a rotation. */
  ACE_GRANT_PREVIOUS_KEY?: string;
}
