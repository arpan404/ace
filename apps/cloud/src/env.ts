import type { SignInObject } from "./broker/sign-in-object.ts";
import type { RelayObject } from "./relay-object.ts";

export interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  /** Spade's connector sign-ins in progress, one object per account (ADR 0141). */
  SIGN_INS: DurableObjectNamespace<SignInObject>;
  /** Account and machine-directory database (ADR 0111). */
  ACCOUNTS: D1Database;
  /** Upgrade rate limit per client address. Absent where no limit is configured. */
  UPGRADES?: RateLimit;
  /** Account API request rate limit per client address. */
  ACCOUNT_REQUESTS?: RateLimit;
  /** Forwarded HTTP (`/m/<hostId>/…`, ADR 0122) per caller address. */
  HTTP_REQUESTS?: RateLimit;
  /** Forwarded HTTP per machine, keyed by host id. */
  HTTP_HOST_REQUESTS?: RateLimit;
  /** Spade's sign-in broker per caller address, then per account (ADR 0141). */
  BROKER_ADDRESS_REQUESTS?: RateLimit;
  BROKER_ACCOUNT_REQUESTS?: RateLimit;
  /**
   * The broker's apps as JSON in place of the shipped list (tests, staging). Each app's client
   * ID and secret are Worker secrets named in its entry, such as `SPADE_CLOUD_ASANA_CLIENT_ID`.
   */
  SPADE_CLOUD_APPS?: string;
  ACE_ACCOUNT_PUBLIC_URL?: string;
  /** Exact account sign-in origins served by this Worker; independent of app CORS origins. */
  ACE_ACCOUNT_PUBLIC_ORIGINS?: string;
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
