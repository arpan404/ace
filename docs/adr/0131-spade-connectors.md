# 0131: Spade's bots use the person's apps through the apps' own remote MCP servers

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: build connectors end to end,
reusing the app makers' own remote MCP servers first, as `spade/docs/design.md`, "Connectors",
proposed). Builds on [ADR 0119](0119-spade-endpoint-keys.md), [ADR 0123](0123-spade-runs-as-its-own-service.md),
[ADR 0126](0126-spade-agents.md) and [ADR 0127](0127-spade-main-bot-and-chat.md). Records how
connectors fit [ADR 0002](0002-local-cli-providers.md). Amended by
[ADR 0136](0136-spade-client-id-metadata-document.md): Spade signs in as a client ID metadata
document hosted on acehq.dev where a server fetches them, with one shared callback address; and by
[ADR 0137](0137-spade-public-connector-apps.md): Spade may ship public client IDs, never secrets,
and signs in with a device code where the maker allows it.

## Context

Spade's bots should work in the person's apps: read and file issues, search their notes, look at
an error, check a payment. Most of those apps now run a hosted MCP server for assistants
(GitHub, Notion, Linear, Atlassian, Sentry, Stripe, Cloudflare, Supabase, Neon, HubSpot, Asana
and others), reached over MCP's streamable HTTP transport and signed in with OAuth under the MCP
authorization spec (revision 2026-07-28, with 2025-11-25 servers still common). Spade already
talks to ace's own MCP endpoint (`spade-ace`), offers its tools deferred through `tool_search` and
`call_tool` so the cached prompt top never changes, gates calls by risk, and treats tool output as
untrusted.

Each bot is one long conversation with its own job (ADR 0126, 0127). A bot that files bugs needs
Linear; a bot that writes a weekly digest does not need the person's payments account.

## Options considered

- **Write our own connector per app.** Full control, but dozens of APIs to follow and keep up
  with; the makers already did this work and keep it current.
- **Run open-source MCP servers locally.** Fills gaps, but each needs a sandbox and a licence
  check, and most need an API key the person must create. Kept for later (design.md, source 3).
- **A hosted catch-all service.** Holds the person's logins off their machine; against ADR 0123's
  "Spade runs on the person's own hardware". Not now.
- **Chosen:** the maker's own remote MCP server, signed in from Spade on the person's machine.

## Decision

1. **Connectors are remote MCP servers.** A connector is one remote MCP server Spade signs in to
   for the person: from a shipped catalogue of the makers' official server addresses
   (`spade/config/connectors.json`, each checked against the maker's own documentation), or any
   server the person adds by URL. Each entry has a name, address, sign-in types and notes. Servers
   that only accept clients the maker approved (today Figma and Vercel) are left out until Spade
   is approved or speaks client ID metadata documents.

2. **Sign-in follows the MCP authorization spec.** Spade finds the authorization server from the
   server's protected-resource metadata (the `WWW-Authenticate` challenge first, then the
   well-known paths), reads its metadata (OAuth, then OpenID Connect paths), registers itself
   dynamically when the server offers it, else uses a client ID the person registered with the
   maker, and runs the authorization code flow with PKCE (S256 only; a server that advertises no
   PKCE is refused), `state`, the `resource` indicator and the issuer check of RFC 9207. The
   redirect is Spade's own loopback address, one per connector,
   `http://127.0.0.1:<port>/v1/connectors/callback/<connector>`, so a server that doesn't name
   itself in its answer can't have its code taken to another server's token endpoint;
   the sign-in page opens in the person's own browser. Every address the sign-in reaches must be
   https and public; only a server the person marks as theirs ("on my own machine or network")
   when adding it by URL may use local addresses, and DNS never decides that. Tokens are refreshed before they expire and
   when the server says they did. Servers that take a static bearer token or API key work too.

3. **Tokens live only in the OS keychain.** Access tokens, refresh tokens, client secrets and
   API keys are kept in the keychain (service `dev.acehq.spade`, accounts `connector:<id>:…`),
   as ADR 0119 does for endpoint keys: never in SQLite, the event log, logs, errors or any API
   answer. SQLite keeps only what is not secret: the address, the authorization server, the client
   ID, scopes, expiry, the account name, and which bots may use which connector. Disconnecting
   deletes the secrets. Without a keychain, a connector cannot be connected; there is no
   plain-text fallback.

4. **Each bot has its own allow list.** Spade, the main bot, may use every connected connector
   unless the person narrows it; a new bot may use none until the person turns some on. The list is
   enforced where tools are looked up for a conversation, so a bot never finds or runs a tool of a
   connector it may not use.

5. **Connector tools are deferred, gated and untrusted.** A connector's tools are offered the way
   ace's are: found with `tool_search`, run through `call_tool`, named `<connector>__<tool>`, so
   the tool list sent to the model never changes as connectors come and go. Risk comes from the
   server's annotations (`destructiveHint` wins, `readOnlyHint` is a read, an unlabelled tool is a
   write), so the gate asks before writes. Every connector's output is untrusted: after it, any
   write in that turn asks. Each call has a timeout and is sent at most once; a call refused before
   it ran says it is safe to retry, and one cut off after sending says its outcome is unknown.
   Tool list changes from the server are picked up while Spade runs.

6. **The app shows connectors in Settings › Spade › Connectors** (catalogue, connected ones,
   connect, disconnect, reconnect when a sign-in expired) and each bot's allow list in the bot's
   edit form. Connector calls do not appear in the chat (ADR 0127).

## How this fits ADR 0002

ADR 0002 is about model providers: ace reaches coding models only through the person's own
logged-in CLIs and never holds those logins. Connectors are not model providers; they are the
person's accounts in their own apps, which they sign in to themselves on the app maker's own
page, for Spade on their own machine to act on. Spade holds the resulting tokens the way it holds
endpoint keys under ADR 0119: in the OS keychain only, never sent anywhere but the server they
were issued for. Nothing here changes how ace or Spade reach model providers, and no token is
proxied through ace, the relay or any hosted service.

## Consequences

- People connect an app in one click where the maker's server registers clients itself; apps
  that require a pre-registered client (Asana, Box, Canva, HubSpot, GitHub's OAuth) need the
  person's own client ID until Spade is registered with the maker, or a token where the maker
  offers one.
- Spade's port changes when the daemon starts it on `127.0.0.1:0`, so a registration is renewed
  when its redirect address no longer matches. A client registered by hand with the maker must
  allow any loopback port.
- A malicious or compromised server can still return text meant to steer the bot; the untrusted
  output rule and the approval gate limit what it can make the bot do.
- Servers that speak only the old HTTP+SSE transport are not supported.

## Tests

- Against a local fake MCP server and a fake OAuth server on 127.0.0.1: discovery, dynamic
  registration, PKCE, the callback and refresh work; a callback with a wrong `state` or issuer is
  refused; no token appears in any API answer or in the database.
- A connected connector's tools are found with `tool_search` and run through `call_tool`; risk
  follows the annotations; output is untrusted.
- A bot not allowed a connector cannot find or run its tools; Spade can by default.
- An expired sign-in that cannot be refreshed shows as needing reconnect, and its calls say so.

## Amendment 1 (2026-11-19): a bot asks to connect an app, and an expired sign-in heals

Decided by: the owner (2026-11-19: "make it easier for every user to connect apps, and agents
should be able to ask to connect an app if it's not connected"). Builds on
[ADR 0154](0154-spade-questions-and-answering-later.md) (question cards, answering later),
[ADR 0171](0171-spade-decides-on-effects.md) (effects) and
[ADR 0193](0193-spade-catalogue-says-what-connects.md) (what connects today).

### Context

A bot asked for something in an app the person hadn't connected ("what's on my Linear board?")
could only say so in words, and the person then went to Settings, found the app, signed in, came
back to the bot and asked again. A sign-in that expired made the bot's calls fail with "ask the
person to reconnect it", which reads like an error and leaves the person to retry by hand.

### Decision

1. **Two tools.** Every bot (not helpers) has `apps_find {need}`, which names the catalogue apps
   that fit a need with their id, name, whether this bot can use them now (`yours`,
   `connected_for_other_bots`, `needs_reconnect`, `no`) and how they connect (`sign_in`, `key`,
   `not_available_yet`); and `app_connect_request {app, why}`. The match is by words only: each
   catalogue entry lists `words`, scored with its name and its category's words, no model call.
2. **The request is a question card of kind `connect`.** Spade makes it from the catalogue and the
   person's connectors; the bot gives only the app and a one-line reason. The card holds the
   app's id and name, the way the person gives it (`sign_in`, `key`, `use` for an app connected
   already for other bots, `reconnect`, `later` for one not available yet), what the bot may do
   with it (from the catalogue's effects), the existing connector and where to make a key. As a
   question card it waits like one, reads as waiting on the person, survives restarts, and takes
   Later (answer later) and Not now (dismiss) exactly as ADR 0154 says.
3. **Only the person connects.** The tool takes no key, token, address or client: any other field
   is refused, and the bot never sees a secret or a connector it wasn't given. A connect card can't
   be answered with `answers` either; it is answered by
   `POST /v1/conversations/{id}/questions/{call}/connected {connector, everyone?}`, which Spade
   accepts only for a signed-in connector of that very app. Spade then lets the bot that asked use
   it (every bot with `everyone`) before it stores the answer, so the turn it wakes has the app's
   tools; every other open card in the conversation for the same app reads the same answer.
4. **No card when there's nothing to ask.** A bot that can use the app already is told so at once.
   An app that isn't available yet stores its card already dismissed: the card says "Not
   available yet" and the bot reads that it can't be had, so nothing waits on the person.
5. **What the bot reads.** Connected: "The person connected <App> as <account>. Its tools are
   yours now…". Later: that the person will connect it later and a `<question_answer>` follows.
   Not now: carry on without it, and don't ask again for this task. A late connection arrives as
   a `<question_answer>` like a late answer.
6. **An expired sign-in heals.** A call refused for an expired token is renewed and sent once more
   (it never ran, so this is safe), and the bot only sees the result. When the sign-in can't be
   renewed, the call isn't answered with a failure: it waits on a `reconnect` card with `retry`,
   and once the person reconnects and the card is answered, Spade runs the call again. Later or
   Not now answer it as not run. A call that already started again when Spade restarted reads as
   an unknown outcome, never run twice. A helper can't ask, so its call reads the failure.
7. **Where it works.** A worker's or a club member's card stands in its own conversation, whose
   row reads as needing the person; the grant goes to the bot that asked.
8. **Connecting is easier everywhere.** `GET /v1/connectors/fit?need=` gives the apps that fit a
   bot's task, which the app suggests in a bot's apps and when a bot is made from a template, each
   a click from connected. A bot's apps menu offers Use <App> for apps already connected. A
   connector's view says when a bot last used it (`last_used_ms`, written at most once a minute)
   and, for a few minutes after a browser sign-in failed, why (`failed`: `declined`,
   `needs_admin`, `expired`, `wrong_server`, `failed`), so the app can say what fixes it ("Linear
   says your account needs admin approval. Ask your admin to allow Spade, then connect again.").
   A first sign-in that failed is found by its id only, never listed as a connected app.

### Consequences

- Bots can recover a missing or expired app inside the task, and the person never retypes the
  request or sees a raw 401.
- Older clients read a connect card as a text question; an answer typed there is the person's
  reply, and the card's own answer stays with clients that know the kind.
- A call held on a Reconnect card keeps its started event without a result until it runs again;
  the transcript treats a call that stopped to ask as no longer running.

### Tests

- A bot asking for an unconnected app shows a connect card and continues after the person
  connects, with the app's tools; the bot can't connect by itself (a key in the call is refused,
  nothing connects, a forged answer is refused); Not now and Later let the bot carry on, and a
  late connection reaches it; an expired sign-in shows Reconnect and retries the call once; an app
  connected once is given to another bot without signing in again; a Coming soon app's card says
  it isn't available yet and nothing waits.
- Matching: an app named in the need comes first, a need without an app name finds apps by what
  they're for, and a need nothing fits finds nothing; a server's refusal naming an admin reads as
  `needs_admin`.
- App: the card's action in words per way, the settled line, the failure words.
