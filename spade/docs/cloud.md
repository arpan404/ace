# Spade's sign-in broker in ace cloud

ace cloud is ace's hosted service at `https://cloud.acehq.dev`: the relay, the account API and,
for Spade, this broker, all in one Cloudflare Worker ([ADR 0141](../../docs/adr/0141-ace-cloud.md);
the broker itself is [ADR 0140](../../docs/adr/0140-spade-cloud.md)). The broker's job is signing people in to apps whose
OAuth needs a client secret, which Spade can't ship: Asana, Box, Canva and HubSpot. It uses the
person's ace account; there is no separate Spade login. It stores no tokens.

Code: `apps/cloud/src/broker` (TypeScript, in the Worker) and `spade/crates/spade-cloud-wire`
(the API's shapes and the token sealing, as Spade speaks them).

## How a sign-in goes

1. The person picks Asana in Settings › Spade › Connectors. Spade asks its daemon for a cloud-specific
   credential (`POST <daemon>/spade/account-grant`, authorized by Spade's own grant).
2. Spade makes a PKCE verifier and a one-time X25519 key and calls `start` with the challenge and
   the public key. The cloud keeps a state bound to the account, the app, the challenge, the key
   and a ten-minute expiry, and answers with Asana's authorization address, whose redirect is
   `https://cloud.acehq.dev/v1/oauth/callback/asana`.
3. Spade opens that address in the person's browser. They sign in at Asana, which redirects to the
   cloud. The cloud checks the state and `iss` and shows "Signed in. You can close this tab."
4. Meanwhile Spade calls `finish` every three seconds with the verifier. Once the person is back,
   the cloud checks the verifier against the challenge, exchanges the code with its client
   secret, seals Asana's token response to Spade's key, answers, and forgets it all.
5. Spade opens the answer with its key and keeps the tokens in the OS keychain, as it keeps every
   connector's.

A renewal is one call: Spade sends the refresh token and a fresh public key to `refresh`, and the
cloud refreshes with its secret and answers sealed.

## API

Every `/v1/oauth/*` request except the callback carries `Authorization: Bearer <cloud credential>`,
a credential signed by ace's account backend using ADR 0111 signing, with kind `machine`,
`aud: "cloud.acehq.dev"` and `purpose: "spade-cloud"`. General machine grants are refused;
the relay rejects cloud credentials through its strict claims parser. Bodies are JSON, at most
16 KB. Refusals are `{"error": "<code>"}`.

| Request                        | Body                                  | Answers                                                                              |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/oauth/{app}/start`   | `{code_challenge, public_key}`        | `200 {sign_in, authorization_url, expires_in, issuer, client_id}`                    |
| `GET /v1/oauth/callback/{app}` | query `state`, `code`, `iss`, `error` | an HTML page: signed in (200), cancelled (200) or not found (400)                    |
| `POST /v1/oauth/{app}/finish`  | `{sign_in, code_verifier}`            | `202 {"status": "waiting"}` or `200 {"status": "done", "sealed": {epk, ciphertext}}` |
| `POST /v1/oauth/{app}/refresh` | `{refresh_token, public_key}`         | `200 {"sealed": {epk, ciphertext}}`                                                  |

`code_challenge` is the 43-character S256 challenge; `public_key`, `epk` and `ciphertext` are
base64url without padding. The sealed plaintext is the maker's token response cut to
`access_token`, `token_type`, `expires_in`, `refresh_token`, `scope` and `id_token`.

| Code                  | Status | Meaning                                                           |
| --------------------- | ------ | ----------------------------------------------------------------- |
| `unauthorized`        | 401    | No grant, or one that didn't verify                               |
| `account_unavailable` | 503    | The account backend's keys couldn't be read, and none were cached |
| `rate_limited`        | 429    | Over the account's or address's budget; `Retry-After` says when   |
| `unknown_app`         | 404    | Not an app the cloud signs in to                                  |
| `app_unavailable`     | 503    | Listed, but its client ID or secret isn't set                     |
| `invalid_request`     | 400    | The body didn't read, or a key or challenge is malformed          |
| `unknown_sign_in`     | 404    | No such sign-in for this account and app, or it was used          |
| `expired`             | 410    | The ten minutes ran out                                           |
| `wrong_verifier`      | 400    | The verifier doesn't match the challenge; the sign-in is dropped  |
| `declined`            | 409    | The person declined, or the redirect named another issuer         |
| `refused`             | 400    | The maker refused the code or refresh token: sign in again        |
| `upstream`            | 502    | The maker couldn't be reached or answered something unusable      |

Budgets, from Workers rate-limit bindings: 240 requests a minute per address
(`BROKER_ADDRESS_REQUESTS`), then 120 a minute per account (`BROKER_ACCOUNT_REQUESTS`). An
account holds at most five sign-ins at once (a sixth drops the oldest).

### Sealing

The cloud makes a fresh X25519 key per answer and computes the shared secret with Spade's public
key. The message key is HKDF-SHA256 with salt `spade-cloud/v1 seal`, the shared secret as input,
and the cloud's then Spade's public key as info. The token response is encrypted with
ChaCha20-Poly1305, a zero nonce (each key seals one message) and associated data
`spade-cloud/v1 <app> finish` or `spade-cloud/v1 <app> refresh`. An all-zero shared secret is
refused. Spade opens it with ring (`spade-cloud-wire`); the Worker seals it with `@noble`
(Workers' Web Crypto has no ChaCha20-Poly1305). `spade-cloud-wire/test-vectors.json` holds fixed
keys and their sealed bytes, and both sides' tests check them.

## Threat model

What the cloud holds:

- **Client secrets** for Spade's registered apps, as Worker secrets only.
- **Sign-ins in progress**, in one Durable Object per account, at most ten minutes: the state,
  account id, app, PKCE challenge, Spade's public key, and the authorization code from the
  redirect until Spade collects it. An alarm drops each when it runs out, and the object's
  storage is emptied once none are left.
- **Rate-limit counters**, in Cloudflare's rate-limit bindings.
- **Tokens in transit** only: an exchange or refresh answer is sealed and sent in the request
  that produced it, then dropped. Never in storage or logs.

Logs (`wrangler tail` only; the Worker's observability is off) carry the account id, the app,
the step and the outcome. Never a token, code, verifier,
state, sign-in handle, grant or secret; a test captures the logs of a whole sign-in and refresh
and checks.

| Attack                                                      | What stops it                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Someone without an ace account uses the broker              | Every request needs a live cloud credential signed by ace cloud's own keys; relay grants and expired or altered ones are refused   |
| Another account finishes or reads someone's sign-in         | A sign-in is bound to its account and app; another account or app gets `unknown_sign_in` and changes nothing                       |
| A stolen authorization code (browser history, a log)        | The exchange needs the PKCE verifier, which only Spade holds; one wrong verifier ends the sign-in                                  |
| A redirect replayed, or a second code injected for a state  | A state takes one answer; a second, and any after it is used, gets the not-found page                                              |
| A redirect from another authorization server (mix-up)       | The callback path must match the state's app; `iss` must exactly match its issuer and is required when metadata advertises support |
| A network observer or a proxy reads the finish answer       | TLS, and the tokens are sealed to Spade's one-time key; a different key, app or purpose doesn't open them                          |
| The cloud's operator or a compromise of the running service | Sees client secrets and the tokens of sign-ins and refreshes during the compromise; no stored tokens exist to take. Rotate secrets |
| A flood of sign-ins or guesses                              | Per-account and per-address budgets, five sign-ins per account                                                                     |
| The code leaks from the callback page                       | The page has no links or scripts, `Referrer-Policy: no-referrer`, a strict CSP, and `Cache-Control: no-store`                      |

Known limits:

- Refresh tokens travel to the cloud over TLS, not sealed to a cloud key.
- The broker shares the Worker with the relay and accounts: a compromise of one exposes the
  others' secrets too (ADR 0141).

Spade keeps working without the cloud: other connectors are untouched, and these four still take
the person's own client ID. With the cloud away, a connected app keeps its current token until it
expires and its row says why it can't renew.

## Configuration

All in `apps/cloud`: `wrangler.jsonc` (bindings, routes) and Worker secrets.

| Setting                                   | Kind       | Meaning                                                                          |
| ----------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `ACE_ACCOUNT_PUBLIC_URL`                  | var        | ace cloud's address (`https://cloud.acehq.dev`); makers redirect to its callback |
| `ACE_GRANT_KEY`, `ACE_GRANT_PREVIOUS_KEY` | secret     | The account API's grant keys, which also verify cloud credentials                |
| `SPADE_CLOUD_<APP>_CLIENT_ID` / `_SECRET` | secret     | Each app's client, named in the app list; an app missing either answers 503      |
| `SPADE_CLOUD_APPS`                        | var        | Another app list as JSON in place of the shipped one (tests, staging)            |
| `SIGN_INS`                                | DO binding | `SignInObject`, sign-ins in progress per account                                 |
| `BROKER_ADDRESS_REQUESTS`, `_ACCOUNT_`    | rate limit | The budgets above                                                                |

In Spade, `SPADE_CLOUD_URL` points at another cloud (development), or `off` leaves these apps on
the person's own client ID.

The app list (`apps/cloud/src/broker/apps.ts`) gives each app's issuer, authorization and token
endpoints, client authentication, scopes, MCP resource and secret names. Endpoints were read from
each maker's live metadata on the date it records. Every catalogue entry marked `via: "cloud"`
must have an app there for the same server; a test checks.

## Deploying (the owner)

The broker ships with ace cloud: `wrangler deploy --env production` from `apps/cloud`
([accounts.md](../../docs/relay/accounts.md) covers the Worker and the `cloud.acehq.dev` domain).
Then, for each app:

1. **Register Spade's app with the maker**, with its own redirect URI
   `https://cloud.acehq.dev/v1/oauth/callback/{app}` (URLs listed below):
   - Asana: an MCP app in the developer console.
   - Box: an MCP client in the Admin Console (Box may limit it to your enterprise; see
     [connector-apps.md](connector-apps.md)).
   - Canva: an integration in the Developer Portal with Canva MCP switched on (public
     integrations are reviewed by Canva).
   - HubSpot: an MCP connector under Development, MCP Connectors.
2. **Set its client as Worker secrets**, from `apps/cloud`:

   ```sh
   export XDG_CONFIG_HOME=~/.ace-cloudflare
   bunx wrangler secret put SPADE_CLOUD_ASANA_CLIENT_ID --env production
   bunx wrangler secret put SPADE_CLOUD_ASANA_CLIENT_SECRET --env production
   # likewise BOX, CANVA, HUBSPOT
   ```

   Secrets apply at once, without a deploy.

3. **Check**: `bun run smoke https://cloud.acehq.dev` (the broker refuses a request without a
   credential), then connect the app from Spade.

### Rotating secrets

1. Create a new client secret at the maker (most let two live at once).
2. `wrangler secret put` the new value; new requests use it at once.
3. Revoke the old secret at the maker.

A secret rotation doesn't sign anyone out: refresh tokens belong to the client ID, not the secret.
Changing a client ID does: every person must connect that app again.

If a secret leaks, revoke it at the maker first, then set the new one. Grant signing keys rotate
with the account API ([accounts](../../docs/relay/accounts.md)); the broker verifies with the
same keys, so nothing else changes.

Each vendor registration must use its own callback URL:

- Asana: `https://cloud.acehq.dev/v1/oauth/callback/asana`
- Box: `https://cloud.acehq.dev/v1/oauth/callback/box`
- Canva: `https://cloud.acehq.dev/v1/oauth/callback/canva`
- HubSpot: `https://cloud.acehq.dev/v1/oauth/callback/hubspot`

The app list records `authorization_response_iss_parameter_supported` from vendor metadata.
When true, missing `iss` declines the sign-in; when supplied, it is always compared exactly,
including trailing slashes. An answer on another vendor's path is refused before exchange.
