# ace accounts on the hosted relay

ace's account backend runs in the same Cloudflare Worker as the hosted relay
(`apps/relay-cloudflare`, [ADR 0110](../adr/0110-cloudflare-relay.md)). One domain
serves the account API over HTTPS and the relay over WSS. WorkOS AuthKit handles
sign-in ([ADR 0100](../adr/0100-ace-account-backend.md)); a signed-in device opens
every machine on its account ([ADR 0111](../adr/0111-account-machine-access.md)).
Local ace use, pairing codes, LAN, Tailscale and the self-hosted Node relay need no
account. WorkOS credentials belong only to this backend. Provider credentials stay
on the person's machine.

## Deploy

`apps/relay-cloudflare/scripts/deploy-wizard.sh` walks through the first deploy and
can be re-run: it asks for the domain and allowed origins, signs in to Cloudflare,
creates the D1 database, applies migrations, deploys, takes the WorkOS keys, sets
the secrets and runs the smoke check. Public values it captures stay in the
git-ignored `apps/relay-cloudflare/.deploy.env`; secrets go only to Cloudflare.

The production settings live in `wrangler.jsonc` under `env.production`; the top
level is for local development and tests. The wizard replaces its placeholders
(`RELAY_DOMAIN`, `ALLOWED_ORIGINS`, `PRODUCTION_DATABASE_ID`); commit the result.
By hand, from `apps/relay-cloudflare`:

1. `bunx wrangler d1 create ace-accounts`, then put the printed id in
   `env.production.d1_databases[0].database_id`.
2. `bunx wrangler d1 migrations apply ACCOUNTS --remote --env production`.
   This applies every migration not yet applied, `0002_login_return.sql` included.
3. In WorkOS, register exactly `https://YOUR_RELAY_DOMAIN/v1/account/callback` as a
   redirect of your AuthKit application. Use a separate WorkOS environment for
   development.
4. Set the domain and origins in `env.production` (`routes` and `vars`): exact
   browser origins, comma-separated, plus `app://ace` for the desktop app, never a
   wildcard. Native iOS requests send no Origin and authenticate with their token.
   Then `bunx wrangler deploy --env production`.
5. Set the secrets. `ACE_ACCOUNT_ENCRYPTION_KEY` seals WorkOS refresh tokens; losing
   or changing it signs everyone out. `ACE_GRANT_KEY` signs grants; it is
   `<key id>:<base64url of a 32-byte Ed25519 seed>`.

   ```sh
   bunx wrangler secret put WORKOS_CLIENT_ID --env production
   bunx wrangler secret put WORKOS_API_KEY --env production
   openssl rand -hex 32 | bunx wrangler secret put ACE_ACCOUNT_ENCRYPTION_KEY --env production
   printf 'k%s:%s' "$(date +%Y%m%d)" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
     | bunx wrangler secret put ACE_GRANT_KEY --env production
   ```

6. `bun run smoke https://YOUR_RELAY_DOMAIN` checks the live Worker without an
   account: it answers, publishes grant keys, starts and cancels a sign-in, and
   refuses relay upgrades that carry no grant.
7. `bun run check:workos https://YOUR_RELAY_DOMAIN` asks the Worker whether WorkOS
   accepts its own API key and client id. The Worker checks them itself
   (`GET /v1/account/health`) and answers with verdicts only, never any part of the
   key; it reuses an answer for 30 seconds.

### Releases deploy it

After the first deploy, each release tag (`v*`) deploys production from that tag: the
`relay` job in `.github/workflows/release.yml` applies D1 migrations, runs
`wrangler deploy --env production` and then the smoke check. A manual run of the
workflow leaves production alone. Secrets set in Cloudflare are untouched by deploys.

The job needs the `CLOUDFLARE_API_TOKEN` repository secret, and fails saying so
without it. Create the token in the Cloudflare dashboard (My Profile › API Tokens)
from the "Edit Cloudflare Workers" template, add Account › D1 › Edit, and limit it to
ace's account and the relay's zone. Then `gh secret set CLOUDFLARE_API_TOKEN` and paste it.

Settings are all or nothing. With none of them, the Worker answers account routes
with 503 `account_not_configured` and refuses `/host` and `/client`, since the
hosted relay requires an account on both ends. A partial or malformed set behaves
the same way rather than serving accounts half configured. `WORKOS_API_URL`
overrides `https://api.workos.com`; only tests use it.

Observability stays off: request logs would record join tickets. Nothing logs
grants, tokens, cookies or callback queries. Account requests are limited per
client address by the `ACCOUNT_REQUESTS` rate-limit binding, relay upgrades by
`UPGRADES`. A cron trigger drops expired sign-ins and sessions hourly.

To rotate the grant key without failing grants in flight, keep the old key's
public half published while its grants live out their five minutes:

1. Copy the current key's entry from `https://YOUR_RELAY_DOMAIN/v1/keys`: its
   `id` and `publicKey`.
2. Set `ACE_GRANT_PREVIOUS_KEY` to `<id>:<publicKey>`, then a new `ACE_GRANT_KEY`
   with a new key id. Either order works: a previous key with the signing key's own
   id is ignored until the new key arrives. `/v1/keys` now publishes both, the
   relay admits grants signed by either, and daemons verifying device grants pick
   up the new id on first sight.
3. After ten minutes (grant lifetime, clock skew and margin), delete
   `ACE_GRANT_PREVIOUS_KEY`. Grants the old key signed are refused from then on.

Only the public key is kept, so the old private key can be discarded at once. The
deploy wizard does steps 1 and 2 when it rotates. If the old key leaked, skip
`ACE_GRANT_PREVIOUS_KEY`: its grants then fail at once, and clients and daemons
fetch a new grant and retry.

For local development, `bun run dev` with the settings in `.dev.vars` (a loopback
`ACE_ACCOUNT_PUBLIC_URL` is accepted) and `bun run migrate:local`. Register the
loopback callback in a development WorkOS environment.

Build the clients against the same origin:

```sh
VITE_ACE_ACCOUNT_URL=https://YOUR_RELAY_DOMAIN bun run web:build
VITE_ACE_ACCOUNT_URL=https://YOUR_RELAY_DOMAIN bun run desktop:build
```

The web and desktop apps open machines on the account through ace's hosted relay on the
same domain: `VITE_ACE_ACCOUNT_URL` as `wss://` (`ws://` for a loopback origin). Set
`VITE_ACE_HOSTED_RELAY_URL=wss://…` only when the relay runs elsewhere. Each app keeps a
random device id for its device grants (`ace.account.deviceId` in local storage).

For iOS, set the Xcode build setting `ACE_ACCOUNT_URL`. No API key belongs in any
client build.

## What the database holds

No column holds a usable credential. Session tokens, login ids, claim tickets,
OAuth state and browser bindings are SHA-256 digests. WorkOS refresh tokens, PKCE
verifiers, and a completed sign-in's session (kept so a lost claim response can be
retried until the sign-in expires) are AES-256-GCM sealed to their row's digest.
Machines are host id, account id, name, platform, first and last seen.

## Account API

Responses are never cached. Credentials travel in the Authorization header, never
in a URL. Errors are `{ "error": code }`. `@ace/client/ace-account` wraps these
routes, validates responses and bounds response bodies.

| Route                             | Behaviour                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/account/login`          | Optional `{ returnTo }`; returns `id`, private `secret`, public `loginUrl`, `expiresAt` (10 minutes)                 |
| `GET /v1/account/login?id=…`      | Browser entry, any number of times; a "Continue to sign in" page, spends nothing                                     |
| `POST /v1/account/login/continue` | The page's form (`id`), once, from the backend's own origin; sets an HttpOnly binding cookie and redirects to WorkOS |
| `GET /v1/account/callback`        | WorkOS callback; checks state, the cookie and PKCE; redirects to `returnTo?status=` when set                         |
| `GET /v1/account/login/:id`       | Claim ticket bearer; `pending` or `complete` with the session                                                        |
| `DELETE /v1/account/login/:id`    | Claim ticket bearer; cancels the sign-in and revokes its session                                                     |
| `GET /v1/account/session`         | Session bearer; refreshes with WorkOS, returns account and expiry                                                    |
| `DELETE /v1/account/session`      | Session bearer; revokes this session                                                                                 |
| `GET /v1/keys`                    | Public grant keys: `{ keys: [{ id, publicKey }] }`                                                                   |
| `POST /v1/grants`                 | Session bearer; `{ kind, subject }` returns `{ token, expiresAt }`                                                   |
| `GET /v1/machines`                | Session bearer; this account's machines, most recently seen first                                                    |
| `DELETE /v1/machines/:hostId`     | Session bearer; forgets one of this account's machines                                                               |

`returnTo` is exactly `ace://account/signed-in` (desktop and iOS) or
`<allowed web origin>/account/signed-in` (the web app's landing page; `app://ace` is
not a web origin); anything else is 400 `invalid_return`. The callback sends the
browser there with only `?status=signed-in|cancelled|failed|expired`: never a
token, code or login id. The app still gets its session from the claim. Without
`returnTo` the callback shows the backend's own page. The sign-in pages are the only
responses that allow inline CSS; the continue page's `form-action` allows `'self'`,
`https:` (the WorkOS and identity-provider redirect chain) and `ace:`, and it sends
`Referrer-Policy: same-origin` so its post carries `Origin`.

A session (`AceAccountGrant`) has `token`, `expiresAt` (7 days) and an `account`
with `id`, `email` and `name`. Poll a sign-in every two seconds until its expiry.
Treat 401 as signed out, 410 as a failed sign-in, 429 as busy and 503 as retryable.
Reading a session, requesting a grant and listing machines each refresh with
WorkOS, so a WorkOS user who is removed loses access at once; concurrent reads
share one refresh.

A grant's `kind` is `machine` (subject: the daemon's host id) or `device`
(subject: the device id). Grants last five minutes; request one per connection.

## Relay admission

`/host` and `/client` upgrades carry a grant as the WebSocket subprotocol
`ace.grant.<token>`, and the 101 echoes it. `/join` needs only its ticket.

| Upgrade                                      | Outcome                                     |
| -------------------------------------------- | ------------------------------------------- |
| Accounts not configured                      | HTTP 503                                    |
| No grant, bad signature, expired, wrong kind | HTTP 401: fetch a new grant                 |
| `/host` machine grant for another host id    | HTTP 403                                    |
| `/client` to a host on another account       | Upgrade, then close 4403 `Not your machine` |
| `/client` to a host not connected            | Upgrade, then close 1008 `Host unavailable` |

A daemon passes `account: { grant, name, platform }` to `connectHostToRelay`;
`grant(signal)` is called before every registration, and `name` and `platform`
label it in the machine list. A client passes `grant` to `connectClientViaRelay`.
After the Noise handshake proves the host key, the relay records host id →
account in D1. A machine signing in to another account moves to it. A machine
forgotten from the list returns the next time it registers.
