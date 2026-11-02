# ace accounts on the relay backend

The relay can serve WorkOS login and ace sessions on the same port as its
encrypted WebSocket streams. Local ace use does not require an account. WorkOS
credentials belong only to this backend. Provider credentials stay on the
person's machine.

## Deploy

Create a WorkOS AuthKit application and configure its login methods. Register
exactly `https://YOUR_BACKEND_DOMAIN/v1/account/callback` as an allowed redirect.
The backend uses WorkOS's hosted login UI; no client secret is shipped in an app.

Copy [the environment example](../../apps/relay/deploy/.env.example) to
`apps/relay/deploy/.env`. Set the domain, WorkOS client ID and API key. Generate a
32-byte encryption key with `openssl rand -hex 32` and set
`ACE_ACCOUNT_ENCRYPTION_KEY`. Keep that key stable and back it up separately from
the database. Losing it invalidates stored sessions. Use a dedicated WorkOS
environment for development.

Set `ACE_ACCOUNT_ALLOWED_ORIGINS` to the exact web app origins, comma-separated,
plus `app://ace` for the packaged desktop. Add loopback origins explicitly for
development. Do not use wildcard origins. Native iOS requests have no Origin
header and authenticate with their session token. The allowlist is a browser
boundary, not a replacement for authentication.

Point the backend domain's DNS at the deployment machine, open ports 80 and 443,
then run from the repository root:

```sh
docker compose --project-directory apps/relay/deploy up --build -d
```

Caddy obtains and renews HTTPS certificates. Both HTTPS account endpoints and
WSS relay endpoints use the same domain. Access logging is off; if adding logs,
omit callback queries, cookies, authorization headers and join tickets. Behind a
shared proxy the backend sees the proxy's IP, so enforce per-client rate limits
at the edge as traffic grows.

The named `accounts` volume persists `/data/accounts/accounts.sqlite`. The image
runs as the unprivileged Node user. A bind mount must be writable by UID 1000.
Use one backend replica for this SQLite deployment. Pending login requests live
in that process; restarts require restarting sign-in. Existing sessions survive.

Build the web and desktop renderer with:

```sh
VITE_ACE_ACCOUNT_URL=https://YOUR_BACKEND_DOMAIN bun run web:build
VITE_ACE_ACCOUNT_URL=https://YOUR_BACKEND_DOMAIN bun run desktop:build
```

For iOS, set the Xcode build setting `ACE_ACCOUNT_URL` to the same HTTPS origin.
`project.yml` writes it into `AceAccountURL` in Info.plist. No API key belongs in
any client build. The UI is Settings > General > Profile on web/desktop and
Settings > Profile on iOS.

Without account environment variables the relay remains usable and the account
API reports unavailable. Partial account configuration fails startup. All of the
following backend settings are required when enabling accounts:

| Variable                      | Value                                  |
| ----------------------------- | -------------------------------------- |
| `ACE_ACCOUNT_PUBLIC_URL`      | HTTPS origin, without a trailing slash |
| `WORKOS_CLIENT_ID`            | AuthKit application client ID          |
| `WORKOS_API_KEY`              | Backend-only WorkOS API key            |
| `ACE_ACCOUNT_ENCRYPTION_KEY`  | 64 hexadecimal characters              |
| `ACE_ACCOUNT_DATA_DIR`        | Private persistent directory           |
| `ACE_ACCOUNT_ALLOWED_ORIGINS` | Exact allowed browser origins          |

Loopback HTTP is accepted for local development. For a local backend, run the
relay with the variables above and register its loopback callback in WorkOS.

## Account API

All routes are under `/v1/account`. Account responses are never cached. Clients
send bearer credentials in the Authorization header, never in a URL. The SDK
entry `@ace/client/ace-account` validates responses and bounds response bodies.

| Route               | Behavior                                                               |
| ------------------- | ---------------------------------------------------------------------- |
| `POST /login`       | Returns `id`, private `secret`, public `loginUrl`, `expiresAt`         |
| `GET /login?id=…`   | Browser entry, sets browser binding and redirects to WorkOS            |
| `GET /callback`     | WorkOS callback; verifies state, cookie and PKCE                       |
| `GET /login/:id`    | Private ticket bearer; returns pending or an ace session grant         |
| `DELETE /login/:id` | Private ticket bearer; cancels login and revokes its result            |
| `GET /session`      | Ace token bearer; refreshes WorkOS session, returns account and expiry |
| `DELETE /session`   | Ace token bearer; revokes this ace session                             |

A login grant has `token`, `expiresAt`, and an `account` containing `id`, `email`
and `name`. The ace token is opaque and authorizes only account endpoints. It is
not a daemon token or a relay host key. Poll at two-second intervals and stop at
the returned login expiry. Treat 401 as signed out, 410 as a failed login and 503
as retryable unavailability. Revoking a session does not revoke paired devices.

Actual production deployment and a live WorkOS login require the operator's
domain and WorkOS environment. Local verification substitutes only the WorkOS
provider, while using real HTTP, SQLite and encryption.
