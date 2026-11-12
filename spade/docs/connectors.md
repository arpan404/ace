# Connectors

Date: 2026-11-12. How Spade's bots use the person's apps through the apps' own remote MCP
servers ([ADR 0131](../../docs/adr/0131-spade-connectors.md)). Built in `spade-connect` (catalogue,
sign-in, sessions, calls), `spade-mcp` (the MCP client shared with ace's tools) and
`spade-server` (tools per bot, API).

## Catalogue

`config/connectors.json` ships the makers' official server addresses, each checked against the
maker's own documentation on the date the file records (`source` names the page). An entry has
`id`, `name`, `url`, `sign_in` and `notes`. `sign_in` lists what works, best first:

| Value          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `oauth`        | Sign in on the maker's page; no client ID needed (see Client below)            |
| `oauth_client` | Sign in, with a client ID (and secret) the person registered with the maker    |
| `token`        | A token or API key the person made in the app, sent as `Authorization: Bearer` |

An entry Spade ships its own client ID for (`config/connector-apps.json`, see Spade's own apps
below) gets `oauth` first. Entries that stay on `oauth_client` say in their notes why: the maker
requires a client secret, which Spade never ships.

Servers that accept only clients the maker approved are left out: Figma, and Vercel, which takes
client ID metadata documents but doesn't name itself in its answers (see Client below). Any other
server is added by URL.

## Signing in

Spade follows the MCP authorization spec (2026-07-28):

1. **Probe.** An unauthenticated `initialize` to the server. A success means no sign-in is needed.
   A 401 carries a `WWW-Authenticate: Bearer` challenge, read for `resource_metadata` and `scope`.
2. **Protected-resource metadata.** From the challenge's address, else
   `/.well-known/oauth-protected-resource/<path>` then `/.well-known/oauth-protected-resource`.
   Its `resource` must be on the server's own origin; it is the `resource` sent with every
   authorization and token request (RFC 8707).
3. **Authorization-server metadata.** For issuer `https://a/t`: OAuth with the path inserted,
   OpenID Connect with it inserted, then appended (`/.well-known/oauth-authorization-server/t`,
   `/.well-known/openid-configuration/t`, `/t/.well-known/openid-configuration`); without a path,
   the OAuth then OpenID Connect root documents. The metadata's `issuer` must be the one asked
   about, and `code_challenge_methods_supported` must include `S256`, or Spade refuses.
4. **Client.** In the MCP spec's order ([ADR 0136](../../docs/adr/0136-spade-client-id-metadata-document.md),
   [ADR 0137](../../docs/adr/0137-spade-public-connector-apps.md)):
   a client ID the person gave, now or earlier for this issuer; else Spade's own registered app for
   this issuer (see Spade's own apps below); else Spade's client ID metadata
   document, `https://acehq.dev/oauth/spade.json`
   ([`apps/marketing/public/oauth/spade.json`](../../apps/marketing/public/oauth/spade.json)),
   when the metadata has `client_id_metadata_document_supported: true` and either
   `authorization_response_iss_parameter_supported: true` or no registration endpoint; else the
   one Spade registered earlier with this issuer, if its redirect still matches; else dynamic
   registration (RFC 7591) as a public native client (`token_endpoint_auth_method: none`,
   `application_type: native`). A server with none of these answers `409` with
   `needs: "client_id"`. `SPADE_CLIENT_METADATA_URL` replaces the document's address in
   development.
5. **Scopes.** The challenge's, else the resource metadata's `scopes_supported`, plus
   `offline_access` when the authorization server offers it.
6. **Browser.** The app opens the returned `sign_in_url` (PKCE S256, a 32-byte random `state`,
   `resource`, `scope`). With a registered or hand-made client the redirect is the connector's
   own, `http://127.0.0.1:<Spade's port>/v1/connectors/callback/<connector id>`: an answer that
   comes back to another connector's address is refused, which keeps a server that sends no `iss`
   from mixing up sign-ins. As the metadata document, it is the one address the document lists,
   `http://127.0.0.1:<Spade's port>/v1/connectors/callback` (any port is allowed on loopback,
   RFC 8252): the `state` picks the sign-in, `iss` is then required, and an answer at the address
   its sign-in didn't use is refused. The document is used only while Spade listens on 127.0.0.1.
7. **Callback.** The `state` must be one Spade started, unused, and under ten minutes old; it is
   spent on first use, whatever the answer. The `iss` parameter is checked by RFC 9207: compared
   as a plain string when present, and required when the server advertises
   `authorization_response_iss_parameter_supported` or the sign-in is as the metadata document.
   Only then is the code exchanged with the
   verifier. An `error` from the server, and any failed code exchange, is shown in Spade's own words only.

Spade's port changes when the daemon starts it on `127.0.0.1:0`; a client Spade registered is
registered again on the next sign-in when the redirect no longer matches. A client registered by
hand must allow any loopback port.

Every address Spade fetches or posts to while signing in comes from a server (metadata,
registration and token endpoints, and the authorization page too), so each is held to
`spade-fetch`'s rules for web pages: `https`, and every address its name resolves to public and not
this machine's own or on its links. The request then connects only to the addresses checked, with
no proxy and no redirect, so a second DNS answer can't swap them. Endpoints on other origins are
fine. An answer naming any private or local address, even beside public ones, is refused. Only a
connector the person marked as local when adding it by URL ("On my own machine or network", sent
as `local: true`) may reach local addresses, or `http` on loopback; DNS never decides it, and
catalogue servers never are. The server's own address is checked the same way before anything is
sent to it. Sign-in requests give up after 60 seconds;
answers stop at 256 KB as they arrive.

## Spade's own apps

`config/connector-apps.json` ([ADR 0137](../../docs/adr/0137-spade-public-connector-apps.md))
lists apps the owner registered with a maker for Spade: the catalogue entry, the `issuer` the client
ID belongs to, the `client_id` (empty until registered; such entries are ignored), the `grant`,
optional `scopes`, and the `source` page saying the grant needs no secret. They are public client
IDs: the file is refused whole if anything in it is named like a secret, a connect request offering
a `client_secret` for Spade's own app answers `400`, and these sign-ins send and keep no secret.
An app is used only when the authorization server's metadata names its `issuer`. Which makers allow
this, and how to register each, is in [connector-apps.md](connector-apps.md).

- **`browser`:** the authorization code grant as above, with PKCE and no secret, back to
  `http://127.0.0.1:<Spade's port>/v1/connectors/callback/<catalogue entry>`, registered with the
  maker without a port.
- **`device`:** the device authorization grant (RFC 8628). Spade posts `client_id`, `scope` and
  `resource` to the server's `device_authorization_endpoint` and answers `202` with the code and the
  maker's page (`verification_uri_complete` when given), held to the address rules above. It then
  polls the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, waiting
  the server's `interval` (five seconds if none) and five more after each `slow_down`; the `error`
  field decides whatever the HTTP status, since GitHub answers errors with `200`.
  `authorization_pending` and network errors wait; `expired_token`, `access_denied`, any other
  error, or the code's lifetime (900 seconds if unsaid) ends it. The connector's `device` then says
  `expired`, `denied` or `failed` for ten minutes, and `POST /v1/connectors/{id}/connect` starts
  again. The device code itself is never shown, stored or logged. Tokens are kept as for any
  sign-in. Disconnecting stops the polling.

## Tokens

Access and refresh tokens, client secrets and API keys live only in the OS keychain: service
`dev.acehq.spade`, accounts `connector:<id>:access`, `connector:<id>:refresh`,
`connector:<id>:client_secret`. They are never in the database, events, logs, errors or any API
answer. The database (`settings` table, keys `connectors` and `connectors.access`) keeps the
address, issuer, token endpoint, resource, client ID, scopes, expiry, the account name (from an ID
token, for display) and the allow lists. Without a keychain only servers needing no sign-in can be
connected.

An access token is renewed with its refresh token when under a minute is left, and whenever the
server refuses it. A refused refresh (or none to use) marks the connector `needs_reconnect`: its
tools stay findable, and each call answers that the person must reconnect it. Renewals are done
once however many calls ask.

## Sessions and tools

Each connector has a live MCP session (streamable HTTP) opened in the background once Spade is
listening, its tool list read on connect, on every `notifications/tools/list_changed`, and every
ten minutes. A server that cannot be reached is tried again after 2 seconds, doubling to 5
minutes, and shows as `unreachable` with the reason.

A connector's tools are named `<connector id>__<tool>` and described as `<Name>: <description>`.
They are all deferred (found with `tool_search`, run through `call_tool`), so the tool list sent
to the model never changes. Risk comes from the server's annotations: `destructiveHint: true` is
destructive, else `readOnlyHint: true` is a read, else a write; the gate asks before writes and
always before destructive calls. All connector output is untrusted, so any write later in that
turn asks.

A call is sent once, with a 60-second timeout. Refused before it ran (the session was gone, the
token was refused): "Not run … It is safe to try again", and a refused token is renewed for the
next try. Cut off after sending: "Unknown outcome".

## Who may use what

Each bot has an allow list. Spade, the main bot, may use every connected connector unless the
person narrows it; a new bot may use none until the person turns some on. The engine looks up a
conversation's bot on every tool listing and call, so a bot never finds or runs a tool of a
connector it may not use, and a change applies from its next step. Disconnecting a connector
removes it from every list.

## API

All under `/v1` with Spade's bearer token, except the callback.

| Method and path                      | Body                                                                                   | Answer                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/connectors`                 |                                                                                        | `{catalogue: [entry], connectors: [connector]}`                                                                                                                                            |
| `POST /v1/connectors`                | `{catalogue}` or `{url, name?, local?}`, plus `token?`, `client_id?`, `client_secret?` | `200 {connector}` when connected at once (a token, or no sign-in needed); `202 {id, sign_in_url}` to open in the browser; `202 {id, device: {code, url, expires_in}}` for a device sign-in |
| `GET /v1/connectors/{id}`            |                                                                                        | `{connector}`; `404`. Poll this after opening the sign-in                                                                                                                                  |
| `POST /v1/connectors/{id}/connect`   | optional `{token?, client_id?, client_secret?}`                                        | As `POST /v1/connectors`: signs in again                                                                                                                                                   |
| `DELETE /v1/connectors/{id}`         |                                                                                        | `204`; `404`. Deletes its secrets and its place in every allow list                                                                                                                        |
| `GET /v1/agents/{id}/connectors`     |                                                                                        | `{all: bool, connectors: [id]}`                                                                                                                                                            |
| `PUT /v1/agents/{id}/connectors`     | `{all?: bool, connectors?: [id]}`                                                      | The list as stored; `400` for an unknown connector, `404` for an unknown agent                                                                                                             |
| `GET /v1/connectors/callback[/{id}]` | query `code`, `state`, `iss`, `error`                                                  | An HTML page: "Connected to …" (`200`) or why not (`400`). Open, no token; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a CSP that loads nothing                             |

A connector: `{id, name, url, catalogue, local, sign_in: "oauth"|"token"|"none", state, account, tools,
problem, device?}`, where `state` is `connected`, `connecting`, `unreachable`, `needs_reconnect` or
`signing_in`, and `device` is `{code, url, state: "waiting"|"expired"|"denied"|"failed",
expires_at_ms}` during a device sign-in and for ten minutes after it ended without connecting. Errors are `{error}`, with `needs: "client_id"` (`409`, register a client with the
maker) or `needs: "token"` (`422`, the server refused the token). `422` without `needs`: the
server cannot be signed in to (no metadata, no PKCE). `502`: it could not be reached. `503`: no
keychain.

## Not yet

- Step-up sign-in on a `403 insufficient_scope`: today the call fails and the person reconnects.
- The old HTTP+SSE transport, MCP Apps (interactive UI), and connector triggers.
- Token revocation at the server on disconnect (RFC 7009); Spade only forgets its tokens.
