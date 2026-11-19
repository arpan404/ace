import type { GrantKeySet } from "./index.ts";

/**
 * The account backend's grant keys this build trusts for the person's standing (ADR 0178
 * §12.8): a fresh sign-in, and an account device counting as the person. Only the public halves
 * ship; the private key stays in the backend's `ACE_GRANT_KEY`. A rotation adds the next key here
 * a release before the backend signs with it, and drops the old one a release after. Nothing at
 * runtime adds to this set: `ACE_ACCOUNT_URL` may point a daemon at another backend, but its
 * grants carry no standing unless its key is listed here. Tests inject their own keys in code.
 *
 * `k20261102` is cloud.acehq.dev's key, as `GET https://cloud.acehq.dev/v1/keys` published it
 * on 2026-11-18.
 */
export const shippedGrantKeys: GrantKeySet = {
  keys: [{ id: "k20261102", publicKey: "4YnbPAZLpD557zJQT9bDShIgb4lSIpvda8dHoDmZPM8" }],
};
