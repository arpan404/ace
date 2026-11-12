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
| `oauth`        | Sign in on the maker's page; Spade registers itself with the server            |
| `oauth_client` | Sign in, with a client ID (and secret) the person registered with the maker    |
| `token`        | A token or API key the person made in the app, sent as `Authorization: Bearer` |

Servers that accept only clients the maker approved (Figma, Vercel) are left out until Spade is
approved or speaks client ID metadata documents. Any other server is added by URL.

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
4. **Client.** A client ID the person gave; else the one Spade registered earlier with this
   issuer, if its redirect still matches; else dynamic registration (RFC 7591) as a public client
   (`token_endpoint_auth_method: none`). A server with no registration answers `409` with
   `needs: "client_id"`.
5. **Scopes.** The challenge's, else the resource metadata's `scopes_supported`, plus
   `offline_access` when the authorization server offers it.
6. **Browser.** The app opens the returned `sign_in_url` (PKCE S256, a 32-byte random `state`,
   `resource`, `scope`). The redirect is `http://127.0.0.1:<Spade's port>/v1/connectors/callback`.
7. **Callback.** The `state` must be one Spade started, unused, and under ten minutes old; it is
   spent on first use, whatever the answer. The `iss` parameter is checked by RFC 9207: compared
   as a plain string when present, and required when the server advertises
   `authorization_response_iss_parameter_supported`. Only then is the code exchanged with the
   verifier. An `error` from the server is shown only as its code.

Spade's port changes when the daemon starts it on `127.0.0.1:0`; a client Spade registered is
registered again on the next sign-in when the redirect no longer matches. A client registered by
hand must allow any loopback port.

Addresses must be `https`, or `http` on loopback. Sign-in requests follow no redirects and give
up after 60 seconds; answers are read up to 256 KB.

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

| Method and path                    | Body                                                                           | Answer                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/connectors`               |                                                                                | `{catalogue: [entry], connectors: [connector]}`                                                                                                                |
| `POST /v1/connectors`              | `{catalogue}` or `{url, name?}`, plus `token?`, `client_id?`, `client_secret?` | `200 {connector}` when connected at once (a token, or no sign-in needed); `202 {id, sign_in_url}` to open in the browser                                       |
| `GET /v1/connectors/{id}`          |                                                                                | `{connector}`; `404`. Poll this after opening the sign-in                                                                                                      |
| `POST /v1/connectors/{id}/connect` | optional `{token?, client_id?, client_secret?}`                                | As `POST /v1/connectors`: signs in again                                                                                                                       |
| `DELETE /v1/connectors/{id}`       |                                                                                | `204`; `404`. Deletes its secrets and its place in every allow list                                                                                            |
| `GET /v1/agents/{id}/connectors`   |                                                                                | `{all: bool, connectors: [id]}`                                                                                                                                |
| `PUT /v1/agents/{id}/connectors`   | `{all?: bool, connectors?: [id]}`                                              | The list as stored; `400` for an unknown connector, `404` for an unknown agent                                                                                 |
| `GET /v1/connectors/callback`      | query `code`, `state`, `iss`, `error`                                          | An HTML page: "Connected to …" (`200`) or why not (`400`). Open, no token; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a CSP that loads nothing |

A connector: `{id, name, url, catalogue, sign_in: "oauth"|"token"|"none", state, account, tools,
problem}`, where `state` is `connected`, `connecting`, `unreachable`, `needs_reconnect` or
`signing_in`. Errors are `{error}`, with `needs: "client_id"` (`409`, register a client with the
maker) or `needs: "token"` (`422`, the server refused the token). `422` without `needs`: the
server cannot be signed in to (no metadata, no PKCE). `502`: it could not be reached. `503`: no
keychain.

## Not yet

- Client ID metadata documents (the spec's preferred registration), which need a document hosted
  at an `https` address of ace's; then Vercel can be added.
- Step-up sign-in on a `403 insufficient_scope`: today the call fails and the person reconnects.
- The old HTTP+SSE transport, MCP Apps (interactive UI), and connector triggers.
- Token revocation at the server on disconnect (RFC 7009); Spade only forgets its tokens.
