# 0131: Spade's bots use the person's apps through the apps' own remote MCP servers

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: build connectors end to end,
reusing the app makers' own remote MCP servers first, as `spade/docs/design.md`, "Connectors",
proposed). Builds on [ADR 0119](0119-spade-endpoint-keys.md), [ADR 0123](0123-spade-runs-as-its-own-service.md),
[ADR 0126](0126-spade-agents.md) and [ADR 0127](0127-spade-main-bot-and-chat.md). Records how
connectors fit [ADR 0002](0002-local-cli-providers.md).

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
   redirect is Spade's own loopback address, `http://127.0.0.1:<port>/v1/connectors/callback`;
   the sign-in page opens in the person's own browser. Tokens are refreshed before they expire and
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
