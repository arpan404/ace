# Spade Cloud

Spade Cloud is Spade's hosted backend at `https://cloud.acehq.dev`
([ADR 0140](../../docs/adr/0140-spade-cloud.md)). Its first job is signing people in to apps whose
OAuth needs a client secret, which Spade can't ship: Asana, Box, Canva and HubSpot. It uses the
person's ace account; there is no separate Spade login. It stores no tokens.

Code: `spade/crates/spade-cloud` (the service, binary `spade-cloud`) and
`spade/crates/spade-cloud-wire` (the API's shapes and the token sealing, shared with Spade).

## How a sign-in goes

1. The person picks Asana in Settings › Spade › Connectors. Spade asks its daemon for a machine
   grant (`POST <daemon>/spade/account-grant`, authorized by Spade's own grant).
2. Spade makes a PKCE verifier and a one-time X25519 key and calls `start` with the challenge and
   the public key. The cloud keeps a state bound to the account, the app, the challenge, the key
   and a ten-minute expiry, and answers with Asana's authorization address, whose redirect is
   `https://cloud.acehq.dev/v1/oauth/callback`.
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

Every `/v1/oauth/*` request except the callback carries `Authorization: Bearer <machine grant>`,
an ADR 0111 grant of kind `machine` signed by ace's account backend. Bodies are JSON, at most
16 KB. Refusals are `{"error": "<code>"}`.

| Request                        | Body                                  | Answers                                                                              |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`                  |                                       | `200 {"ok": true, "version"}`                                                        |
| `POST /v1/oauth/{app}/start`   | `{code_challenge, public_key}`        | `200 {sign_in, authorization_url, expires_in, issuer, client_id}`                    |
| `GET /v1/oauth/callback`       | query `state`, `code`, `iss`, `error` | an HTML page: signed in (200), cancelled (200) or not found (400)                    |
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

Budgets, in memory: per account a burst of 60 requests, then one a second; per address a burst
of 120, then two a second. An account holds at most five sign-ins at once (a sixth drops the
oldest).

### Sealing

The cloud makes a fresh X25519 key per answer and computes the shared secret with Spade's public
key. The message key is HKDF-SHA256 with salt `spade-cloud/v1 seal`, the shared secret as input,
and the cloud's then Spade's public key as info. The token response is encrypted with
ChaCha20-Poly1305, a zero nonce (each key seals one message) and associated data
`spade-cloud/v1 <app> finish` or `spade-cloud/v1 <app> refresh`. An all-zero shared secret is
refused. Implemented once, with ring, in `spade-cloud-wire`.

## Threat model

What the cloud holds:

- **Client secrets** for Spade's registered apps, in its environment only.
- **Sign-ins in progress**, in memory, at most ten minutes: the state, account id, app, PKCE
  challenge, Spade's public key, and the authorization code from the redirect until Spade
  collects it.
- **Rate-limit counters**, in memory.
- **Tokens in transit** only: an exchange or refresh answer is sealed and sent in the request
  that produced it, then dropped. No database, no disk, no logs of tokens.

Logs carry the account id, the app, the step and the outcome. Never a token, code, verifier,
state, sign-in handle, grant or secret; a test captures the logs of a whole sign-in and refresh
and checks.

| Attack                                                      | What stops it                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Someone without an ace account uses the broker              | Every request needs a live machine grant signed by ace's account backend; device grants and expired or altered ones are refused    |
| Another account finishes or reads someone's sign-in         | A sign-in is bound to its account and app; another account or app gets `unknown_sign_in` and changes nothing                       |
| A stolen authorization code (browser history, a log)        | The exchange needs the PKCE verifier, which only Spade holds; one wrong verifier ends the sign-in                                  |
| A redirect replayed, or a second code injected for a state  | A state takes one answer; a second, and any after it is used, gets the not-found page                                              |
| A redirect from another authorization server (mix-up)       | `iss`, when present, must name the app's issuer (RFC 9207); otherwise the sign-in ends as declined                                 |
| A network observer or a proxy reads the finish answer       | TLS, and the tokens are sealed to Spade's one-time key; a different key, app or purpose doesn't open them                          |
| The cloud's operator or a compromise of the running service | Sees client secrets and the tokens of sign-ins and refreshes during the compromise; no stored tokens exist to take. Rotate secrets |
| A flood of sign-ins or guesses                              | Per-account and per-address budgets, five sign-ins per account, 50,000 in all                                                      |
| The code leaks from the callback page                       | The page has no links or scripts, `Referrer-Policy: no-referrer`, a strict CSP, and `Cache-Control: no-store`                      |

Known limits:

- A machine grant has no audience. One handed to the cloud could be replayed at the relay's
  `/host` within its five minutes; the relay's Noise handshake still requires the machine's own
  key. An audience claim in `@ace/account-grant` is the fix.
- Refresh tokens travel to the cloud over TLS, not sealed to a cloud key.
- Sign-ins in progress live in one process, so the service runs one replica until they move to a
  shared store.

Spade keeps working without the cloud: other connectors are untouched, and these four still take
the person's own client ID. With the cloud away, a connected app keeps its current token until it
expires and its row says why it can't renew.

## Configuration

Only through the environment:

| Variable                                  | Default                   | Meaning                                                                    |
| ----------------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `PORT`                                    | `8080`                    | Where it listens (plain HTTP behind the host's TLS edge)                   |
| `SPADE_CLOUD_PUBLIC_URL`                  | `https://cloud.acehq.dev` | Its own address; makers redirect to its `/v1/oauth/callback`               |
| `SPADE_CLOUD_ACCOUNT_ORIGIN`              | `https://relay.acehq.dev` | ace's account backend, whose `/v1/keys` verify grants                      |
| `SPADE_CLOUD_ADDRESS_HEADER`              | unset (peer address)      | The header the host puts the client address in, for per-address budgets    |
| `SPADE_CLOUD_APPS_FILE`                   | the shipped `apps.json`   | Another apps file                                                          |
| `SPADE_CLOUD_<APP>_CLIENT_ID` / `_SECRET` | unset                     | Each app's client, named in `apps.json`; an app missing either answers 503 |
| `RUST_LOG`                                | `info`                    | Log filter; logs are JSON lines on stdout                                  |

In Spade, `SPADE_CLOUD_URL` points at another cloud (development), or `off` leaves these apps on
the person's own client ID.

The apps file (`spade/crates/spade-cloud/apps.json`) lists each app's issuer, authorization and
token endpoints, client authentication, scopes, MCP resource and variable names. Endpoints were
read from each maker's live metadata on the date it records. Every catalogue entry marked
`via: "cloud"` must have an app there for the same server; a test checks.

## Deploying (the owner)

Nothing here has been deployed. To bring it up on Railway:

1. **Register Spade's app with each maker**, with redirect URI
   `https://cloud.acehq.dev/v1/oauth/callback`:
   - Asana: an MCP app in the developer console.
   - Box: an MCP client in the Admin Console (Box may limit it to your enterprise; see
     [connector-apps.md](connector-apps.md)).
   - Canva: an integration in the Developer Portal with Canva MCP switched on (public
     integrations are reviewed by Canva).
   - HubSpot: an MCP connector under Development, MCP Connectors.
2. **Create the Railway service** from this repository. In its settings set the root directory
   to `spade` and the config file path to `/spade/crates/spade-cloud/railway.toml`. That builds
   `crates/spade-cloud/Dockerfile` and health-checks `/health`. Keep one replica.
3. **Set variables** on the service: `SPADE_CLOUD_ADDRESS_HEADER=x-forwarded-for`, and for each
   registered app its `SPADE_CLOUD_<APP>_CLIENT_ID` and `SPADE_CLOUD_<APP>_CLIENT_SECRET` (for
   example `SPADE_CLOUD_ASANA_CLIENT_ID`). Mark the secrets sealed. The defaults cover the public
   URL and account origin.
4. **Add the custom domain** `cloud.acehq.dev` under the service's Networking settings. Railway
   shows a CNAME target; at the DNS host for `acehq.dev` (Cloudflare) add a `CNAME` record for
   `cloud` pointing to it, DNS only (grey cloud) so Railway can issue its certificate. Railway
   may also ask for a `TXT` verification record; add it as shown.
5. **Check**: `curl https://cloud.acehq.dev/health` answers `{"ok":true,…}`, and the deploy log
   lists each app with `ready: true`. Then connect Asana from Spade.

Locally: `docker build -f crates/spade-cloud/Dockerfile -t spade-cloud .` from `spade/`, then
`docker run -p 8080:8080 -e SPADE_CLOUD_PUBLIC_URL=http://127.0.0.1:8080 spade-cloud`.

### Rotating secrets

1. Create a new client secret at the maker (most let two live at once).
2. Set the new value in Railway; the service restarts with it (Railway overlaps the old
   deployment for 20 seconds and drains it for 30, so sign-ins in flight finish).
3. Revoke the old secret at the maker.

A secret rotation doesn't sign anyone out: refresh tokens belong to the client ID, not the secret.
Changing a client ID does: every person must connect that app again.

If a secret leaks, revoke it at the maker first, then set the new one. Grant signing keys belong
to the account backend and rotate there ([accounts](../../docs/relay/accounts.md)); the cloud
fetches new keys by itself.
