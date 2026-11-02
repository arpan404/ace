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

Run these from `apps/relay-cloudflare`.

1. Create the database and put the id it prints into `d1_databases[0].database_id`
   in `wrangler.jsonc`:

   ```sh
   bunx wrangler d1 create ace-accounts
   ```

2. Apply the migrations in `migrations/`:

   ```sh
   bunx wrangler d1 migrations apply ACCOUNTS --remote
   ```

3. Create a WorkOS AuthKit application and register exactly
   `https://YOUR_RELAY_DOMAIN/v1/account/callback` as its redirect URI. Use a separate
   WorkOS environment for development.

4. Set the secrets. `ACE_ACCOUNT_ENCRYPTION_KEY` seals WorkOS refresh tokens; losing
   or changing it signs everyone out. `ACE_GRANT_KEY` signs grants; it is
   `<key id>:<base64url of a 32-byte Ed25519 seed>`.

   ```sh
   bunx wrangler secret put WORKOS_CLIENT_ID
   bunx wrangler secret put WORKOS_API_KEY
   openssl rand -hex 32 | bunx wrangler secret put ACE_ACCOUNT_ENCRYPTION_KEY
   printf 'k%s:%s' "$(date +%Y%m%d)" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
     | bunx wrangler secret put ACE_GRANT_KEY
   ```

5. Deploy with the public origin and the browser origins allowed to call the API
   (exact origins, comma-separated, plus `app://ace` for the desktop app; never a
   wildcard). Native iOS requests send no Origin and authenticate with their token.

   ```sh
   bunx wrangler deploy \
     --var ACE_ACCOUNT_PUBLIC_URL:https://YOUR_RELAY_DOMAIN \
     --var ACE_ACCOUNT_ALLOWED_ORIGINS:https://app.example.com,app://ace
   ```

Settings are all or nothing. With none of them, the Worker answers account routes
with 503 `account_not_configured` and refuses `/host` and `/client`, since the
hosted relay requires an account on both ends. A partial or malformed set behaves
the same way rather than serving accounts half configured. `WORKOS_API_URL`
overrides `https://api.workos.com`; only tests use it.

Observability stays off: request logs would record join tickets. Nothing logs
grants, tokens, cookies or callback queries. Account requests are limited per
client address by the `ACCOUNT_REQUESTS` rate-limit binding, relay upgrades by
`UPGRADES`. A cron trigger drops expired sign-ins and sessions hourly.

To rotate the grant key, set a new `ACE_GRANT_KEY` with a new key id and deploy.
Grants signed with the old key fail at the relay within five minutes of issue;
clients and daemons fetch a new grant and retry.

For local development, `bun run dev` with the settings in `.dev.vars` (a loopback
`ACE_ACCOUNT_PUBLIC_URL` is accepted) and `bun run migrate:local`. Register the
loopback callback in a development WorkOS environment.

Build the clients against the same origin:

```sh
VITE_ACE_ACCOUNT_URL=https://YOUR_RELAY_DOMAIN bun run web:build
VITE_ACE_ACCOUNT_URL=https://YOUR_RELAY_DOMAIN bun run desktop:build
```

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

| Route                          | Behaviour                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `POST /v1/account/login`       | Returns `id`, private `secret`, public `loginUrl`, `expiresAt` (10 minutes)  |
| `GET /v1/account/login?id=…`   | Browser entry, once; sets an HttpOnly binding cookie and redirects to WorkOS |
| `GET /v1/account/callback`     | WorkOS callback; checks state, the cookie and PKCE                           |
| `GET /v1/account/login/:id`    | Claim ticket bearer; `pending` or `complete` with the session                |
| `DELETE /v1/account/login/:id` | Claim ticket bearer; cancels the sign-in and revokes its session             |
| `GET /v1/account/session`      | Session bearer; refreshes with WorkOS, returns account and expiry            |
| `DELETE /v1/account/session`   | Session bearer; revokes this session                                         |
| `GET /v1/keys`                 | Public grant keys: `{ keys: [{ id, publicKey }] }`                           |
| `POST /v1/grants`              | Session bearer; `{ kind, subject }` returns `{ token, expiresAt }`           |
| `GET /v1/machines`             | Session bearer; this account's machines, most recently seen first            |
| `DELETE /v1/machines/:hostId`  | Session bearer; forgets one of this account's machines                       |

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
| `/client` to a host on another account       | Upgrade, then close 1008 `Not your machine` |
| `/client` to a host not connected            | Upgrade, then close 1008 `Host unavailable` |

A daemon passes `account: { grant, name, platform }` to `connectHostToRelay`;
`grant(signal)` is called before every registration, and `name` and `platform`
label it in the machine list. A client passes `grant` to `connectClientViaRelay`.
After the Noise handshake proves the host key, the relay records host id →
account in D1. A machine signing in to another account moves to it. A machine
forgotten from the list returns the next time it registers.
