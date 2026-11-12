# ace accounts in ace cloud

ace cloud is ace's one hosted Cloudflare Worker (`apps/cloud`,
[ADR 0110](../adr/0110-cloudflare-relay.md), [ADR 0141](../adr/0141-ace-cloud.md)): the account
API over HTTPS, the relay over WSS, and Spade's connector sign-in broker
([spade/docs/cloud.md](../../spade/docs/cloud.md)), all at `cloud.acehq.dev`. The same Worker
still answers at `relay.acehq.dev`, the name apps released before the rename use. WorkOS AuthKit handles
sign-in ([ADR 0100](../adr/0100-ace-account-backend.md)); a signed-in device opens
every machine on its account ([ADR 0111](../adr/0111-account-machine-access.md)).
Local ace use, pairing codes, LAN, Tailscale and the self-hosted Node relay need no
account. WorkOS credentials belong only to this backend. Provider credentials stay
on the person's machine.

## Deploy

`apps/cloud/scripts/deploy-wizard.sh` walks through the first deploy and
can be re-run: it asks for the domain and allowed origins, signs in to Cloudflare,
creates the D1 database, applies migrations, deploys, takes the WorkOS keys, sets
the secrets and runs the smoke check. Public values it captures stay in the
git-ignored `apps/cloud/.deploy.env`; secrets go only to Cloudflare.

The production settings live in `wrangler.jsonc` under `env.production`; the top
level is for local development and tests. The wizard replaces its placeholders
(`RELAY_DOMAIN`, `ALLOWED_ORIGINS`, `PRODUCTION_DATABASE_ID`); commit the result.
By hand, from `apps/cloud`:

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

### Moving production to cloud.acehq.dev

The production Worker keeps its script name, `ace-relay`: its relay Durable Objects belong to
that name (ADR 0141). The first deploy with ace cloud adds the `cloud.acehq.dev` custom domain
beside `relay.acehq.dev`, the `SignInObject` class (migration `v2`) and two rate limits, and
moves `ACE_ACCOUNT_PUBLIC_URL` to `https://cloud.acehq.dev`. In order, from `apps/cloud`, with
`XDG_CONFIG_HOME=~/.ace-cloudflare` so wrangler uses ace's Cloudflare login:

1. In WorkOS, add `https://cloud.acehq.dev/v1/account/callback` as a redirect of the AuthKit
   application. Keep the relay.acehq.dev one: a sign-in started just before the deploy returns
   there.
2. `bunx wrangler d1 migrations apply ACCOUNTS --remote --env production` (none are new, but it
   is the release job's order).
3. `bunx wrangler deploy --env production`. Wrangler creates the `cloud.acehq.dev` custom domain
   and its DNS record in the `acehq.dev` zone; nothing to do at the DNS host by hand.
   If a `cloud` record already exists in the zone (a CNAME made for ADR 0140's Railway service),
   delete it first, or the custom domain can't be added.
4. `bun run smoke https://cloud.acehq.dev` and `bun run smoke https://relay.acehq.dev`.
5. Only then ship app releases that default to cloud.acehq.dev.

Keep `relay.acehq.dev` on the Worker while any installed app or outside MCP client still uses it.

### Releases deploy it

After the first deploy, each release tag (`v*`) deploys production from that tag: the
`cloud` job in `.github/workflows/release.yml` applies D1 migrations, runs
`wrangler deploy --env production` and then the smoke check on both hostnames. A manual run of the
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
`VITE_ACE_HOSTED_RELAY_URL=wss://…` only when the relay runs elsewhere. Each app's device
grants name its install id, made once and kept for good (`ace.install.id` in local
storage; [ADR 0115](../adr/0115-one-device-one-machine.md)).

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

A daemon registers whenever remote access is on and it is signed in, whatever
other networks it serves: LAN and Tailscale run beside the relay, never instead
of it ([ADR 0112](../adr/0112-remote-networks-together.md)). So signing a machine
in is all it takes to list it here; one that never registered (remote access
off, or an older daemon on LAN or Tailscale alone) isn't in `machines`.

## Public HTTP to a machine

Hosted assistants reach a machine's outside MCP endpoint over plain HTTPS at
`https://cloud.acehq.dev/m/<hostId>/…` ([ADR 0122](../adr/0122-outside-mcp-clients.md)).
Everything under `/m/<hostId>/` goes to that machine with the prefix removed: the MCP
endpoint, its OAuth endpoints and their metadata. RFC 9728 and RFC 8414 metadata URLs
with the path inserted, `/.well-known/<name>/m/<hostId>/…` for `oauth-protected-resource`,
`oauth-authorization-server` and `openid-configuration`, reach the same machine as
`/.well-known/<name>/…`, the address it would serve at its own root. On this path
Cloudflare ends TLS and the relay sees requests and responses in plain text; it stores
and logs none of it. The daemon authorizes every request; the relay checks no account.

The Worker checks the host id (anything malformed is 404), applies two rate limits,
`HTTP_REQUESTS` per caller address (300 a minute) and `HTTP_HOST_REQUESTS` per host id
(600 a minute), and refuses a body over 1 MiB with 413. It forwards the request to the
host's relay object, which:

1. finds the host's registration. None: 503 with `Retry-After: 5`. A daemon that
   registered without `features=http` (older daemons): 404.
2. sends `{"type":"http","ticket":…}` over the encrypted control session. Only daemons
   that declared the feature get it, since older ones drop the session on an unknown
   message. A daemon with `remote.relayMcp` off answers
   `{"type":"reject","ticket":…,"reason":"off"}` (404), one at its limit `"busy"` (503).
3. waits up to 10 seconds for the daemon's outbound `/serve?hostId=…&ticket=…` socket,
   then up to 100 seconds from arrival for the response head (504 after).

One request and its response travel on that socket as binary messages whose first byte
is the kind (`http-frames.ts` in `@ace/relay`):

| Byte | Kind   | Payload                                                                                                     |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `1`  | head   | JSON. Request: `method`, `origin`, `prefix`, `path` (with query), `headers`. Response: `status`, `headers`. |
| `2`  | body   | Up to 60 KiB of body bytes                                                                                  |
| `3`  | end    | None: the body is complete                                                                                  |
| `4`  | abort  | None: that side gave up. Closing the socket means the same.                                                 |
| `5`  | credit | Relay to daemon: big-endian uint32 of response bytes the caller has taken                                   |

The relay sends head, body chunks and end; the request body is complete first. The
daemon answers the same way and keeps at most 1 MiB of response unacknowledged, so the
object never buffers more than that. `origin` and `prefix` are the public base the caller
used, and the daemon serves the request at `<origin><prefix><path>`, its canonical
resource URL. Hop-by-hop headers, `Host`, `Content-Length` and the caller-address headers
Cloudflare adds are dropped; `Authorization` passes untouched. A response can't set
cookies or origin-wide policy (`Set-Cookie`, `Strict-Transport-Security`, `Alt-Svc`,
`Clear-Site-Data` and the like), since every machine shares the relay's host name, and
bodies pass as sent, so handlers don't compress.

Every machine's pages are served from the relay's own origin, which also serves the
account API and sets the HttpOnly `ace_login_*` cookie during sign-in. Any machine on any
account can serve HTML under its `/m/<hostId>/`, so the relay filters the daemon's response
headers again itself and forces these on every forwarded response, whatever the daemon
sends:

- `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox; frame-ancestors 'none'`. Without `allow-same-origin`, each
  page runs in an opaque origin: no cookies, no storage, no same-origin reads of the account
  API or other machines' pages. A daemon's own CSP is kept as a second header; browsers
  enforce both, so it can only tighten.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
  Daemon-sent values of these are dropped.

The daemon's OAuth `/authorize` page (a later task) must work under that sandbox. Forms,
links and self-navigation work. Cookies and `localStorage` don't. A page waiting for
approval in ace polls with `fetch`, which works from an opaque origin only without
credentials, so the poll carries its state in the URL or body.

Each object holds at most 32 requests in flight and 4 event-stream responses
(`subscriptions/listen`); over either, 429 with `Retry-After`. An open exchange keeps the
object awake and billed, so a response is cut after 30 minutes and the client reconnects.
Exchanges live in memory only while a request is in flight; idle, the object holds no
timer or promise for them and hibernates as before. A caller that leaves cancels the
exchange: once a response streams, when its next bytes fail to send; before that, the
Worker sees its request signal end and tells the object (`cancelHttp`). The daemon then
aborts the handler's signal and cancels the response body.

On the daemon, `connectHostToRelay({ http: { enabled, handle } })` declares the feature
and serves each request through `handle(request, signal, { origin, prefix })`. The daemon
reads `remote.relayMcp` for every request and hands it to the outside MCP server's
handler (`ServerOptions.outsideMcpHttp`); until that exists, every request gets 404.
