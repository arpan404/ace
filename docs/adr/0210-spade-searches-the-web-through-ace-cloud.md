# 0210: Spade searches the web through ace cloud

Status: proposed. Date: 2026-11-21. Asked for by the owner (2026-11-21: "start working on search
engine on ace cloud integration through cloudflare ceramic ai"; then "I am using cloudflare ai
gateway"; then "remove search engine setting pages, as we are going full on cloud").

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

- **Who may call.** A Spade acting for a signed-in account: its cloud credential (the
  `spade-cloud` machine grant Spade already shows the sign-in broker, ADR 0140/0141), or a machine
  credential (ADR 0190). The existing grant and principal code reads both; there is no new scheme.
  A browser session is refused (`403 spade_only`), as is any request carrying an `Origin` header,
  so raw results never reach a browser page as a list. An organization's host credential (ADR
  0206) is refused too: it is not a person. A cloud Spade later calls with the same credential
  for the account it acts for.
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

| Limit | Default | Where it is counted | Var |
| --- | --- | --- | --- |
| Burst per caller address | 30 a minute | rate-limit binding `SEARCH_ADDRESS_BURST` (namespace 1010) | binding config |
| Burst per account | 10 a minute | rate-limit binding `SEARCH_ACCOUNT_BURST` (namespace 1009) | binding config |
| Same query again | the 3rd identical query from an account within 60 s is refused | isolate memory, a salted digest only | none |
| Global daily spend | $5 a day, so 20,000 searches at $0.25 per 1,000 | D1 | `ACE_SEARCH_DAILY_DOLLARS` |
| Per account, monthly | 1,000 | D1 | `ACE_SEARCH_MONTHLY` |
| Per new account, monthly | 100 for its first 7 days | D1 | `ACE_SEARCH_NEW_ACCOUNT_MONTHLY`, `ACE_SEARCH_NEW_ACCOUNT_DAYS` |
| Per account, daily | 100 | D1 | `ACE_SEARCH_DAILY` |
| Per machine, monthly | 500 | D1 | `ACE_SEARCH_MACHINE_MONTHLY` |
| Per machine, daily | 60 | D1 | `ACE_SEARCH_MACHINE_DAILY` |
| Per caller address, daily, across accounts | 300 | D1 | `ACE_SEARCH_ADDRESS_DAILY` |

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

The rate-limit bindings count per Cloudflare location, which is fine for bursts. Every count that
must hold globally lives in D1, in one table (`search_counts`: scope, period, count, expiry) with
no query text. An address's counter is keyed by a salted digest of the address, never the address. A search takes all its counters in one D1 batch of conditional upserts, each of
which only adds while under its cap, so concurrent searches can't overshoot. If any counter is
full, those taken are given back and the search is refused. A search Ceramic fails is given back
too. Expired rows are swept hourly in bounded batches (ADR 0170). An account's rows go with the
account.

The same-query check keeps a SHA-256 digest of a random per-isolate salt, the account and the
normalized query, for 60 seconds, in memory only. It never reaches storage or logs.

Every refusal is `429` with `Retry-After` and `{error, reason, retryAfter}`, where `reason` is
one plain sentence Spade can show:

| `error` | `reason` | Retry-After |
| --- | --- | --- |
| `search_busy` | Too many searches this minute. | 60 s |
| `repeated_query` | That search was just asked several times. | 60 s |
| `resting` | ace search is resting today. | to midnight UTC |
| `monthly_spent` | You've used this month's ace searches. They come back on the 1st. | to the 1st, UTC |
| `daily_spent` | You've used today's ace searches. They come back tomorrow. | to midnight UTC |
| `machine_spent` | This machine has used its ace searches for now. | to the window's end |
| `address_spent` | Too many ace searches from this network today. | to midnight UTC |

Other answers: `401 unauthenticated`, `403 spade_only`, `400 invalid_request`,
`502 search_failed` (Ceramic failed), and `503 search_unavailable` (no AI binding or gateway
configured). `GET /v1/search/usage` answers the account's
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
would keep queries (owner setup).

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
