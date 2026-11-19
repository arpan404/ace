import { z } from "zod";

/**
 * What Spade and the broker say to each other, as Spade's `spade-cloud-wire` defines it
 * (`spade/docs/cloud.md`, "API"). Requests are strict, as the Rust types deny unknown fields.
 */

/** `POST /v1/oauth/{app}/start`. */
export const StartRequest = z.strictObject({
  code_challenge: z.string(),
  public_key: z.string(),
});

/** `POST /v1/oauth/{app}/finish`. */
export const FinishRequest = z.strictObject({
  sign_in: z.string().max(256),
  code_verifier: z.string().max(256),
});

/** `POST /v1/oauth/{app}/refresh`. The refresh token travels over TLS only. */
export const RefreshRequest = z.strictObject({
  refresh_token: z.string().min(1).max(8192),
  public_key: z.string(),
});

/** Every refusal is `{"error": "<code>"}` with one of these codes and its status. */
export const REFUSALS = {
  /** No grant, or one that didn't verify. */
  unauthorized: 401,
  /** ace cloud's account settings aren't ready, so no grant can be checked. */
  account_unavailable: 503,
  /** Too many requests from this account or address. */
  rate_limited: 429,
  /** The cloud doesn't sign in to this app. */
  unknown_app: 404,
  /** The cloud lists the app but its client isn't set up. */
  app_unavailable: 503,
  /** The request didn't read. */
  invalid_request: 400,
  /** No sign-in by that name for this account and app, or it was used. */
  unknown_sign_in: 404,
  /** The sign-in ran out of time. */
  expired: 410,
  /** The verifier doesn't match the challenge; the sign-in is dropped. */
  wrong_verifier: 400,
  /** The person declined at the maker, or the answer came from the wrong issuer. */
  declined: 409,
  /** The maker refused the code or the refresh token: sign in again. */
  refused: 400,
  /** The maker couldn't be reached or answered something unusable. */
  upstream: 502,
} as const;
export type Refusal = keyof typeof REFUSALS;
