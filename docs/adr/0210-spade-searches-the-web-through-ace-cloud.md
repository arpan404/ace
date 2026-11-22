# 0210: Spade searches the web through ace cloud

Status: proposed. Date: 2026-11-21. Asked for by the owner (2026-11-21: "start working on search
engine on ace cloud integration through cloudflare ceramic ai"; then "I am using cloudflare ai
gateway"; then "remove search engine setting pages, as we are going full on cloud").
Amendment 1 (2026-11-22, the GPT review of #2584): grants bound to a live machine (§3), paid
attempts keep their reservation, admission all or nothing, a coarse address limit before
authentication, the gateway's settings checked, the repeat check best effort (§4), and no
provider words in Spade's logs (§6). Amendment 2 (2026-11-22, round 2 of that review): the live
check follows the principal reader's session rules and runs inside the reservation (§3), refunds
only on the gateway's documented codes, gateway readings coalesced and sticky, a 5-minute
residual window and the `ACE_SEARCH_ENABLED` kill switch (§4), and the status in Spade's log line
(§6).

Amends:

- [ADR 0002](0002-local-cli-providers.md): a second hosted exception (after ADR 0110/0111's account
  backend), §1.
- `spade/docs/design.md` "Web search": the person's own SearXNG and Brave key are removed (§6).
- The deferred note "hosted search later" (owner, 2026-11-21): this is that work, resumed.

## Context

Spade's `web_search` worked only with the person's own SearXNG, their Brave Search key, or the
model endpoint's built-in search. Most people set up none of them, so most bots couldn't search.

Cloudflare's Web Search API (open beta since 2026-10-02) searches the web from a Worker through an
AI Gateway, billed to the Cloudflare account's AI Gateway credits at the provider's list price. ace
cloud (`apps/cloud`, cloud.acehq.dev) is already a Worker on the owner's Cloudflare account with
the person's ace account behind it (ADR 0110, 0111, 0141).

## Decision

### 1. A hosted exception to ADR 0002

ace cloud runs one search service, `POST /v1/search`, for Spade only. The exception is narrow:

- The searches run on the owner's Cloudflare account and AI Gateway credit. No credential of the
  person's for any provider is asked for, held or proxied. The person's ace account says who is
  asking; nothing else of theirs is sent.
- Query text is never stored or logged, in D1, Worker logs or the gateway (§4). Only counts are
  kept.
- Results are never cached.

### 2. Provider: Ceramic only, through AI Gateway billing

`env.AI.websearch({ gatewayId, query, provider: "ceramic", limit })`, with no `byokAlias`.
Cloudflare's how-to page lists `provider` as `ceramic | exa | linkup` (default `ceramic`) and says
of `byokAlias`: "If set, the request fails instead of falling back to AI Gateway credits when the
key is not configured." Leaving the alias out and naming `ceramic` is what bills Ceramic to the
gateway's credits. `@cloudflare/workers-types` 5.20261121.1 documents `provider` as "Optional BYOK
web-search provider configured on the gateway", but types it as a plain `string`; the docs'
reading is the one used, and the call names the provider explicitly so a changed default can't
switch it.

- **Ceramic** (default, $0.25 per 1,000, zero data retention) is the only provider.
- **Linkup** is not used, not even as a fallback: its terms (§5) let Linkup train on prompts,
  which breaks the no-logging promise above.
- **Exa** is not used: Cloudflare marks it as not zero data retention.

When Ceramic fails, the route answers `502 search_failed` and Spade falls back (§6). There is no
second provider.

### 3. The route serves Spade's `web_search` calls, not a search API

- **Who may call.** A Spade acting for a signed-in account, with its cloud credential: the
  `spade-cloud` machine grant Spade already shows the sign-in broker (ADR 0140/0141), verified by
  the existing grant code. Nothing else is accepted: no session, no bare machine credential, no
  general machine grant, and nothing carrying an `Origin` header (`403 spade_only`), so raw
  results never reach a browser page as a list.
- **Bound to a live machine** (amendment 1, review of #2584). A grant counts only while the
  machine it names (its subject) holds a live machine credential on that account (ADR 0190), by
  the principal reader's own rules for a machine credential (amendment 2): a session credential,
  unexpired and not revoked, on a session that hasn't expired or been signed out, names the same
  account, and has no deletion recorded. The session may be retired: `ace login` retires its
  token when it exchanges it for a credential that becomes its only holder (`sole`), and the
  credential still speaks for it. Revoking that credential removes the session with it. This is
  read from D1 (`machine_credentials` by host and account, indexed in migration 0011) when the
  grant is checked, and again inside the statement that takes the counters (amendment 2), so a
  revocation or sign-out at any point before admission stops the search before anything is sent,
  not when the grant expires. A session can mint a cloud grant naming any host id
  through `/v1/grants`; one naming a host the account holds no live credential for opens nothing
  here (`403 machine_unknown`), so a new subject can't dodge the machine caps. An organization's
  host credential has no personal session behind it and is refused the same way.
  - A daemon from before machine credentials (ADR 0190) has none, so its Spade can't use ace
    search until the daemon updates; it falls back to the endpoint's search (§6).
  - A separate grant purpose just for search was considered and left out for now. It would narrow
    one case: a broker grant leaked on its own (say, from the broker's logs or a request to it)
    couldn't search. Both would still be minted by the same daemon and held in the same Spade
    process, so a leak of Spade's memory gives either. The per-use binding above ends both at
    once, and a leaked broker grant can search only until it expires, about five minutes, inside
    the same caps. Adding the purpose (daemon, protocol and spade-ace) stays open as a follow-up.
  - A hosted (cloud) Spade later needs its own authenticated identity: an authorized hosted
    workload with its own quota, not a person's machine credential and not the per-address
    limits. That needs its own amendment.
- **What it answers.** `{results: [{url, title, snippet, site}], provider: "ceramic", usage}`, at
  most 10 results. Every result keeps its source link, as Cloudflare's crawler standards require:
  "Every search result must include a link to the location of the crawled content." Spade puts the
  results into a bot's tool result, where the bot cites the links.
- **Bounds.** Query 1 to 400 characters after trimming (Cloudflare allows 1,024); body at most
  4 KiB; Ceramic's answer read to at most 256 KiB; title 300, snippet 500 and URL 2,048
  characters; only `http` and `https` URLs. `freshness` (`day`, `week`, `month`, `year`) drops a
  result whose `lastModifiedDate` is known and older; one with no date is kept.

### 4. Limits, all enforced on cloud.acehq.dev

Every limit is checked by the Worker; nothing the client sends changes one. In order:

| Limit                                             | Default                                                        | Where it is counted                                           | Var                                                             |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Coarse, per caller address, before authentication | 300 a minute                                                   | rate-limit binding `SEARCH_ADDRESS_REQUESTS` (namespace 1010) | binding config                                                  |
| Burst per account, after authentication           | 10 a minute                                                    | rate-limit binding `SEARCH_ACCOUNT_BURST` (namespace 1009)    | binding config                                                  |
| Same query again (best effort)                    | the 3rd identical query from an account within 60 s is refused | isolate memory, a salted digest only                          | none                                                            |
| Global daily spend                                | $5 a day, so 20,000 searches at $0.25 per 1,000                | D1                                                            | `ACE_SEARCH_DAILY_DOLLARS`                                      |
| Per account, monthly                              | 1,000                                                          | D1                                                            | `ACE_SEARCH_MONTHLY`                                            |
| Per new account, monthly                          | 100 for its first 7 days                                       | D1                                                            | `ACE_SEARCH_NEW_ACCOUNT_MONTHLY`, `ACE_SEARCH_NEW_ACCOUNT_DAYS` |
| Per account, daily                                | 100                                                            | D1                                                            | `ACE_SEARCH_DAILY`                                              |
| Per machine, monthly                              | 500                                                            | D1                                                            | `ACE_SEARCH_MACHINE_MONTHLY`                                    |
| Per machine, daily                                | 60                                                             | D1                                                            | `ACE_SEARCH_MACHINE_DAILY`                                      |
| Per caller address, daily, across accounts        | 300                                                            | D1                                                            | `ACE_SEARCH_ADDRESS_DAILY`                                      |

Why these numbers:

- **1,000 a month** is about 33 a day: a day of coding questions plus a few research reports.
  At Ceramic's price it costs $0.25 per account per month at most, and there is no fallback
  provider to make a search cost more.
- **100 a day** stops one runaway bot from spending the month in an afternoon.
- **The machine caps** sit below the account's, so one leaked machine credential can't spend the
  whole allowance. The machine is the grant's subject or the credential's host id.
- **The address cap** stops sign-ups from one place multiplying the allowance. A shared office
  network of a few people fits under 300.
- **New accounts** get 100 for their first 7 days. The account's age is its first machine
  registration (`machines.created_at`, already kept and indexed). An account with no machine
  registered counts as new.
- **The global breaker** protects the owner's credit if every per-person limit fails. When it is
  reached, every account gets "ace search is resting today" until midnight UTC.
- **The address limit before authentication is coarse** (amendment 1): it is charged before the
  caller is known, so a tight one would let unauthenticated noise lock out everyone on a shared
  network. The tight burst is the account's, charged after authentication.

The rate-limit bindings count per Cloudflare location, which is fine for bursts. Every count that
must hold globally lives in D1, in one table (`search_counts`: scope, period, count, expiry) with
no query text. An address's counter is keyed by a salted digest of the address, never the address.

**Admission is all or nothing** (amendment 1). A search takes all its counters in one D1
statement: it adds one to every counter only when none is at its cap, and otherwise writes
nothing. One statement is one transaction, so concurrent searches can't overshoot a cap, a refused
search never briefly holds another search's counter, and a Worker cut short mid-request strands
no increment. After a refusal the counters are read once to name the full one in the reason.

**A paid attempt keeps its reservation** (amendments 1 and 2). Once the call to Ceramic is
dispatched, the search counts against every counter, the global breaker included, whatever comes
back: an oversized, truncated or malformed answer, any HTTP error status (a `401`, `403` or `404`
may have come from past the gateway), or a binding error whose billing is unknown. Only the
gateway's own documented codes that prove the call was never sent give the reservation back, in
one statement. Cloudflare's binding contract (Agents › Web search, "Handle errors") says "Every
error has a code: the API's own code when it sends one, such as web_search_payment_required, or
one derived from the HTTP status". So `web_search_payment_required` (no credits, so not sent)
and `web_search_unsupported_runtime` (the runtime refused before any request) refund, read from
the error body or the thrown error. Codes derived from a status, and anything unknown, keep the
reservation. Expired
rows are swept hourly in bounded batches (ADR 0170). An account's rows go with the account.

The same-query check is **best effort**: it keeps a SHA-256 digest of a random per-isolate salt,
the account and the normalized query, for 60 seconds, in that isolate's memory only, so requests
on other isolates or locations aren't seen together. It never reaches storage or logs. Strict
limits are the D1 counters.

**The gateway keeps nothing** (amendment 1). Web Search requests are logged by AI Gateway like any
other while its log collection is on, which would keep raw queries, so privacy can't rest on a
dashboard setting alone:

- Search uses its own gateway, `ace-search` (`ACE_SEARCH_GATEWAY`), created with log collection,
  Logpush and caching off.
- With `ACE_SEARCH_CF_ACCOUNT_ID` and `ACE_SEARCH_CF_API_TOKEN` (an API token with AI Gateway
  Read) set, the Worker reads the gateway's settings from Cloudflare's API
  (`GET /accounts/{id}/ai-gateway/gateways/{gateway}`) on first use and every 5 minutes after (a
  refusal is read again after a minute). It searches only while `collect_logs` is false,
  `cache_ttl` is 0 and `logpush` isn't true. A gateway that keeps anything is refused whatever
  else says so.
- Readings are coalesced (amendment 2): one at a time per isolate, shared by every caller waiting
  on it, so an answer that started earlier can't land after, and replace, a later refusal. Once a
  reading has seen the gateway keeping logs, it stays refused across failed readings, and the
  owner's word doesn't lift it; only a reading that shows it keeps nothing does.
- When the settings can't be read (no token, or the API failed), it searches only if
  `ACE_SEARCH_GATEWAY_VERIFIED` is `logs-off-cache-off`, the owner's word that they checked by
  hand.
- Otherwise the route answers `503 search_unavailable` before counting anything, and Spade falls
  back (§6). The token is never logged; the log says `gateway_keeps_logs` or `gateway_unchecked`.
- **The residual window** (amendment 2). A good reading is trusted for 5 minutes, so if someone
  turns logging, Logpush or caching on, queries sent in up to the next 5 minutes may be kept.
- **The operating rule** (amendment 2): before anyone changes the `ace-search` gateway's
  settings, ace search is turned off with the kill switch, `ACE_SEARCH_ENABLED=false` in
  `env.production.vars`, deployed, and turned on again only after the settings are back. With it
  off the route answers `503 search_unavailable` before anything else: no gateway reading, no
  count, no query sent.

Every refusal is `429` with `Retry-After` and `{error, reason, retryAfter}`, where `reason` is
one plain sentence Spade can show:

| `error`          | `reason`                                                          | Retry-After         |
| ---------------- | ----------------------------------------------------------------- | ------------------- |
| `search_busy`    | Too many searches this minute.                                    | 60 s                |
| `repeated_query` | That search was just asked several times.                         | 60 s                |
| `resting`        | ace search is resting today.                                      | to midnight UTC     |
| `monthly_spent`  | You've used this month's ace searches. They come back on the 1st. | to the 1st, UTC     |
| `daily_spent`    | You've used today's ace searches. They come back tomorrow.        | to midnight UTC     |
| `machine_spent`  | This machine has used its ace searches for now.                   | to the window's end |
| `address_spent`  | Too many ace searches from this network today.                    | to midnight UTC     |

Other answers: `401 unauthenticated`, `403 spade_only`, `403 machine_unknown`,
`400 invalid_request`, `502 search_failed` (Ceramic failed), and `503 search_unavailable` (no AI
binding or gateway configured, or a gateway that may keep queries). `GET /v1/search/usage` answers the account's
`{month: {used, allowance}, day: {used, cap}, resetsAt}` with the same credentials.

### 5. Terms

Read on 2026-11-21, quoted from the live pages.

**Ceramic**, https://ceramic.ai/terms-of-service (Last Modified: February 27, 2026):

- §7(o): no making Output available "on a standalone basis or as a separately accessible component
  of another product or service; provided that you may display Output to your authorized end users
  within your own application so long as such Output is integrated into your application's
  functionality, is incident to the end user's real-time query, and is not independently
  accessible, extractable, or downloadable by end users or third parties". §3 is shaped for this:
  results serve Spade's tool calls at the moment of the person's query, and the route refuses
  browsers and anything but Spade.
- §7(p): no keeping Output "beyond what is reasonably necessary to display such Output to your
  authorized end users in the ordinary and real-time course of use". Nothing is cached.
- §7(n): no compiling Output "for the purpose of creating or contributing to any database,
  dataset, index, or corpus". See §7: phase 2's index is never built from Ceramic results.
- §7(b): no "provide access to the Services to a third party"; §8 licenses Ceramic's IP "solely
  for the purpose of receiving the Services for your internal business purposes".
- §9.5: "Customer shall not submit Personal Data ... unless Customer has first requested and
  executed a Data Processing Agreement with Ceramic by contacting legal@ceramic.ai." People's
  queries may hold personal data. **Follow-up: ask Ceramic for a DPA.**

**Linkup**, https://www.linkup.so/terms-of-use (Last update: August 2025): §6.5 grants Linkup "a
worldwide right to use, reproduce and modify the Client Data, including prompts, for the purposes
of providing, maintaining, developing, training and improving the Linkup Solution", and §6.4 bars
"acting as a wrapper of the Linkup APIs". Hence no Linkup (§2).

**Cloudflare**, Service-Specific Terms (developer platform, Last updated: September 28, 2026),
"Cloudflare Workers AI; AI Gateway":

- "Machine learning models and search services made available by Cloudflare in connection with
  the Services constitute Third-Party Products (as defined in the Agreement) whether or not you
  have entered an agreement with the third-party provider." "Where you have not agreed other terms
  with the model or search service provider, by using such Third-Party Products, you agree to
  comply with all restrictions, including any acceptable use policies, in the standard terms of
  the model or search service provider."
- Through AI Gateway, "the Cloudflare Data Processing Addendum and Information Security Exhibit do
  not apply to your use of such Third-Party Products accessed via AI Gateway."
- "Unless otherwise agreed, Cloudflare does not use any Customer Content to train generative AI
  tools."
- The Self-Serve Subscription Agreement §3: use of a Third-Party Product "is solely between you and
  the applicable Third-Party Product provider"; §5: Beta Services may be discontinued at any time,
  with no support obligation and no liability.

So billing through Cloudflare doesn't lift Ceramic's terms: they apply as if ace had agreed to
them, and Cloudflare's DPA doesn't cover the search. The Unified Billing page adds that zero data
retention "does not control AI Gateway logging": the gateway must have log collection off, or it
would keep queries. The Worker checks that itself before every search (§4, "The gateway keeps
nothing").

**The owner chose to proceed on this basis** (2026-11-21: "I am using cloudflare ai gateway"),
with the shape in §2 to §4 fitted to Ceramic's terms and the DPA as a follow-up.

### 6. Spade searches with ace only

The owner removed the self-host options (2026-11-21: "remove search engine setting pages, as we
are going full on cloud"). A search setting most people never filled in is replaced by one that
works when they are signed in, and Spade has one search path to keep right. So:

- `spade-search` has one backend, `ace`, which calls `POST https://cloud.acehq.dev/v1/search`
  (`SPADE_CLOUD_URL` in development; `off` turns it off) with the cloud credential Spade already
  holds in memory for the sign-in broker. No secret is stored.
- SearXNG and Brave are gone, with Settings › Spade › Web search and its API. A Brave key already
  in the keychain is left there and no longer read. Old `search.json` files, and an old stored
  SearXNG address, still load; their fields are ignored.
- `web_search` tries, in order:
  1. **ace search**, when the person is signed in and ace search isn't backing off.
  2. **The model endpoint's own built-in search** (`spade-models` `web_search`), where the bot's
     model has one, when ace search refused, failed, is offline or the person is signed out.
     There is no setting for it.
  3. Otherwise **one plain sentence**: "Sign in to ace to search the web.", "ace search is resting
     today.", or the refusal's own reason.
- **Back-off.** After a `429`, Spade doesn't ask ace search again until `Retry-After` has passed
  (at most a day, then it asks again); after a failure, not for 30 seconds. While it waits, the
  refusal's sentence is the answer, so a bot can't hammer the route.
- **Usage.** Settings › Spade › General shows one quiet line: this month's searches against the
  allowance.
- **Logs** (amendment 1). An endpoint's error message can echo the query, so neither ace search's
  nor the endpoint search's failure keeps a server's words: Spade logs a fixed outcome code
  (`ace_search_failed`, `endpoint_search_failed`), and an endpoint search failure says only its
  HTTP status, which the `endpoint_search_failed` line carries as `status` (amendment 2).

### 7. Phase 2: ace's own index of developer sources

Later, ace may run a focused index of developer sources (documentation sites, package registries,
changelogs, standards), fetched by its own crawler under robots.txt and Cloudflare's crawler
standards. **It is never built from Ceramic results**, which Ceramic §7(n) forbids. It would be a
second provider behind the same route and limits, and needs its own ADR.

## Consequences

- People signed in to ace can search with no setup. People not signed in search only through their
  model endpoint, if it has search.
- The owner pays for searches. The limits bound one account at $0.25 a month at most, and the
  breaker bounds everyone at the configured dollars a day.
- Ceramic is a single point of failure: when it is down, bots fall back to endpoint search or say
  so.
- Web Search is a Cloudflare beta, which may change or end without notice. The route answers
  `503`/`502` cleanly and Spade falls back.
- Open: a Ceramic DPA for personal data in queries (§5).
