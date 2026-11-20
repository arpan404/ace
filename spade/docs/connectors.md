# Connectors

Date: 2026-11-12. How Spade's bots use the person's apps through the apps' own remote MCP
servers ([ADR 0131](../../docs/adr/0131-spade-connectors.md)). Built in `spade-connect` (catalogue,
sign-in, sessions, calls), `spade-mcp` (the MCP client shared with ace's tools) and
`spade-server` (tools per bot, API).

## Catalogue

`config/connectors.json` ships the makers' official server addresses, each checked against the
maker's own documentation and the server's live sign-in metadata on its `checked` day (`source`
names the page). An entry has `id`, `name`, `category`, `url`, `sign_in`, `notes`, `source`,
`checked`, `words` (what a task needing it may say: "issues", "inbox"; see A bot asks below),
and maybe `key_url` (where to make a token), `via`, `waits_for`, `effects` and `every_tool`. `sign_in` lists what works, best first:

| Value          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `oauth`        | Sign in on the maker's page; no client ID needed (see Client below)            |
| `oauth_client` | Sign in, with a client ID (and secret) the person registered with the maker    |
| `token`        | A token or API key the person made in the app, sent as `Authorization: Bearer` |

An entry Spade ships its own client ID for (`config/connector-apps.json`, see Spade's own apps
below) gets `oauth` first. So does an entry marked `"via": "cloud"` (Asana, Box, Canva, Front,
Google's seven, HubSpot, Slack, Zoom):
the maker requires a client secret, which Spade never ships, so it signs in through
[Spade Cloud](cloud.md) with the person's ace account (ADR 0140). Signed out of ace, connecting it
says so with Sign in to ace; the person's own client ID still works. Its row says "Signs in
through Spade Cloud", or why it can't renew while the cloud or ace is away; it keeps working until
its token expires. Renewals go through the cloud, and the tokens stay in the keychain.

`GET /v1/connectors` adds `ready` to each entry ([ADR 0193](../../docs/adr/0193-spade-catalogue-says-what-connects.md)):
`sign_in` when one click works on this build, `key` when only a token does, `later` when it waits
for the owner: an entry marked `"waits_for": "maker_approval"` (Figma, Pipedrive, Ramp, Vercel,
whose makers let in only apps they approved), or one through Spade Cloud that the cloud doesn't
list at `GET /v1/oauth/apps`. The app offers Sign in only for `sign_in`; a `later` entry says
"Coming soon." Its marks are bundled in the app (`@ace/ui-core/app-icons`). Any other server is
added by URL. Which apps are listed and why is in [connector-apps.md](connector-apps.md).

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
   this catalogue entry and issuer (see Spade's own apps below); else Spade's client ID metadata
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
   `http://localhost:<Spade's port>/v1/connectors/callback` (any port is allowed on loopback; a
   name, not `127.0.0.1`, because some servers refuse an IP address in a document's redirects,
   ADR 0136 amendment 1): the `state` picks the sign-in, `iss` is then required, and an answer at the address
   its sign-in didn't use is refused. The document is used only while Spade listens on 127.0.0.1, which the browser reaches as
   `localhost`.
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
An app is tied to its catalogue entry and issuer: it is used only when the person connects that
entry, at the entry's own address, and its authorization server's metadata names the app's
`issuer`. A server added by URL never signs in as Spade, even one naming the same issuer, since its
token would then be sent to that server. Which makers allow
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
server refuses it; a call refused that way is sent once more on the renewed sign-in (it never ran),
so the bot sees only its result. A refused refresh (or none to use) marks the connector
`needs_reconnect`: its tools stay findable, and a call to one waits on a Reconnect card (below)
instead of failing. Renewals are done once however many calls ask.

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

## A bot asks

[ADR 0131, amendment 1](../../docs/adr/0131-spade-connectors.md#amendment-1-2026-11-19-a-bot-asks-to-connect-an-app-and-an-expired-sign-in-heals).
Built in `spade_connect::fit` (matching, what a bot may do), `spade_core::question::connect` (the
card and what the bot reads), `engine/apps.rs` and `tools/apps.rs`.

- **`apps_find {need}`** lists up to five catalogue apps that fit, best first, one JSON object a
  line: `{id, name, connected, signs_in}`. `connected` is `yours`, `connected_for_other_bots`,
  `needs_reconnect` or `no`; `signs_in` is `sign_in`, `key` or `not_available_yet`. Matching is by
  words: the app's name or id named outright (20), a word its entry lists (3), its category's word
  (1); apps sharing only a category word are left out when anything fits better.
- **`app_connect_request {app, why}`** (any other field is refused; `why` up to 300 characters)
  answers at once when the bot can use the app already. Otherwise it stores a `question_asked`
  whose one question is `{kind: "connect", prompt: why, app, name, way, can, connector?, key_url?,
retry?}`, with `way` `sign_in`, `key`, `use`, `reconnect` or `later`, and waits like
  `ask_user`. A `later` card is stored with its `question_dismissed`, and the bot reads at once
  that the app can't be connected yet. Helpers don't have it.
- **The person connects** with the connector routes as usual, then answers the card with
  `POST /v1/conversations/{id}/questions/{call}/connected {connector, everyone?}`: `202`; `400`
  when the connector isn't that app, isn't signed in yet, or the card isn't a connect card; `409`
  when the card isn't open. The bot that asked is let use the connector (every bot with
  `everyone`) before the answer is stored, `{connector, account?, everyone?}`, on every open card
  for that app in the conversation. Later and Not now are the question routes' `defer` and
  `dismiss`; answers in `answers` are refused for a connect card.
- **A Reconnect card** stands for a connector call refused because its sign-in couldn't be renewed:
  stored with the call's own id and `retry: true`, it holds the call open. Answered, the call runs
  again (a call that had started again before a restart reads as an unknown outcome); Later, Not
  now or a typed reply answer it as not run.

In a debug build, `SPADE_DEV_CATALOGUE` names a JSON list of catalogue entries that replace the
shipped ones with the same id and are marked local, so a development run signs in to a fake app on
this machine. A release never reads it.

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
| `GET /v1/connectors/fit?need=`       |                                                                                        | `{apps: [id]}`: the catalogue apps that fit, best first, at most six                                                                                                                       |
| `GET /v1/connectors/{id}`            |                                                                                        | `{connector}`; `404`. Poll this after opening the sign-in                                                                                                                                  |
| `POST /v1/connectors/{id}/connect`   | optional `{token?, client_id?, client_secret?}`                                        | As `POST /v1/connectors`: signs in again                                                                                                                                                   |
| `DELETE /v1/connectors/{id}`         |                                                                                        | `204`; `404`. Deletes its secrets and its place in every allow list                                                                                                                        |
| `GET /v1/agents/{id}/connectors`     |                                                                                        | `{all: bool, connectors: [id]}`                                                                                                                                                            |
| `PUT /v1/agents/{id}/connectors`     | `{all?: bool, connectors?: [id]}`                                                      | The list as stored; `400` for an unknown connector, `404` for an unknown agent                                                                                                             |
| `GET /v1/connectors/callback[/{id}]` | query `code`, `state`, `iss`, `error`                                                  | An HTML page: "Connected to …" (`200`) or why not (`400`). Open, no token; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a CSP that loads nothing                             |

A connector: `{id, name, url, catalogue, local, sign_in: "oauth"|"token"|"none", state, account, tools,
problem, device?, bots, last_used_ms?, failed?}`, where `last_used_ms` is when a bot last ran one of its tools (written
at most once a minute), `failed` why its last browser sign-in failed in the last ten minutes
(`declined`, `needs_admin`, `expired`, `wrong_server`, `failed`; a first sign-in that failed is
found by `GET /v1/connectors/{id}` only), and `bots` (in `GET /v1/connectors` and `GET /v1/connectors/{id}`) is the
ids of the bots allowed to use it, in roster order: Spade, the main bot, uses every connector until
the person narrows it (and none while it is switched off); a bot only those the person allowed. `state` is `connected`, `connecting`, `unreachable`, `needs_reconnect` or
`signing_in`, and `device` is `{code, url, state: "waiting"|"expired"|"denied"|"failed",
expires_at_ms}` during a device sign-in and for ten minutes after it ended without connecting. Errors are `{error}`, with `needs: "client_id"` (`409`, register a client with the
maker) or `needs: "token"` (`422`, the server refused the token). `422` without `needs`: the
server cannot be signed in to (no metadata, no PKCE). `502`: it could not be reached. `503`: no
keychain.

## Not yet

- Step-up sign-in on a `403 insufficient_scope`: today the call fails and the person reconnects.
- The old HTTP+SSE transport, MCP Apps (interactive UI), and connector triggers.
- Token revocation at the server on disconnect (RFC 7009); Spade only forgets its tokens.
