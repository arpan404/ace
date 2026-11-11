# Spade design

Date: 2026-11-08, updated 2026-11-10. Status: draft. Decisions marked **decided** are the owner's; everything else
is a proposal waiting for the owner's review.

## What Spade is

An assistant that runs on the person's own hardware beside their ace daemon, with ace as its front
end. People talk to Spade, the main bot, and to bots they or others made. Spade works across their
apps through connectors, remembers what matters, and acts on their machines through ace: it starts
and steers coding agents, drives the browser and computer use, and controls the daemon. A laptop
works; a Mac mini, a home Linux box or a small VPS keeps it always on. A hosted Spade, for people
without spare hardware, may come later.

## Decisions

| Decision                                                                                                                                                                       | Status   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Spade is Rust, in ace's repository at `spade/`, open source under Apache-2.0 like the rest of ace                                                                              | decided  |
| Spade runs on the person's own hardware beside the ace daemon; a hosted Spade may come later                                                                                   | decided  |
| Rust is the backend only; Spade's screens are ace's React (desktop, web) and Swift (iOS)                                                                                       | decided  |
| Spade acts on the person's machines and daemon through ace                                                                                                                     | decided  |
| Storage is one SQLite file per machine (`spade-store`)                                                                                                                         | decided  |
| Models are reached through endpoints the person adds, in any of three formats: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages; no dependency on any one gateway | decided  |
| Subscription models (Codex, Claude Code, OpenCode) are reached only through the person's own logged-in CLI via the ace daemon, never by reading their login tokens             | decided  |
| The harness steers by default: a message sent mid-turn joins the running turn                                                                                                  | decided  |
| The whole harness is in scope: background tools, duplicate-proof writes, native tool loading, skills, context, images                                                          | decided  |
| Prompts are append-only so the cache hit rate inside agent turns stays near 99% (see Caching)                                                                                  | decided  |
| Development and internal testing call models with an OpenCode Go API key                                                                                                       | decided  |
| Model access uses the `genai` crate behind Spade's own `spade-models` crate (see Models)                                                                                       | decided  |
| The model list is curated: the current model of each family worth running, nothing older                                                                                       | decided  |
| Connectors reuse existing MCP servers before we write our own (see Connectors)                                                                                                 | proposed |
| A hosted Spade would reach daemons through ace's relay with a Spade grant (draft ADR `docs/adr/drafts/spade-daemon-access.md`)                                                 | proposed |
| Endpoint keys are typed into the app and kept in the OS keychain only, then the endpoint's environment variable (ADR 0116)                                                     | decided  |

## Shared with ace

Spade speaks ace's protocols exactly. Each has one source of truth in ace and is checked from Rust
with test vectors recorded from ace's TypeScript. On the same machine only the wire messages
matter; the encrypted channel and grants matter when Spade reaches a daemon from elsewhere:

- **Encrypted channel:** `Noise_XX_25519_ChaChaPoly_SHA256` plus ace's prologue and flow credit
  (`packages/secure-channel`). Rust side: `snow`.
- **Account grants:** Ed25519, base64url claims and signature (`packages/account-grant`). Rust
  side: `ed25519-dalek`.
- **Wire messages:** ace's Zod schemas are exported to JSON Schema (`tools/protocol-docs`) and
  Rust types are generated from that. A check fails when the generated types are stale. Nobody
  keeps two copies by hand.

## Crates

| Crate            | Job                                                                                                                                                                | State                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `spade-models`   | Endpoints and models, chat, typed output, streaming, cache counts                                                                                                  | built                 |
| `spade-core`     | Pure logic, no I/O: conversation events, transcript, prompts, spending, checkpoints, titles; later the agent loop, approval gate, turn-taking and memory decisions | built (chat), growing |
| `spade-store`    | SQLite: conversations, event log, spending ledger                                                                                                                  | built                 |
| `spade-server`   | Local API and reply engine                                                                                                                                         | in progress           |
| `spade-testkit`  | Test-only fake model endpoint                                                                                                                                      | built                 |
| `spade-protocol` | Types generated from ace's schemas, plus Spade's own                                                                                                               | planned               |
| `spade-ace`      | Talks to the ace daemon: locally first, through the relay for a hosted Spade                                                                                       | planned               |
| `spade-mcp`      | Connector catalogue and MCP client (`rmcp`)                                                                                                                        | planned               |
| `spade-memory`   | Memory storage and search                                                                                                                                          | planned               |

Rules carried over from ace: pure core with a thin I/O shell; clocks, ids, randomness and
network endpoints are injected; outside data is parsed before use; tests assert behaviour
through the public API with real edges (sockets, SQLite) where possible.

## Models

**Endpoints, not gateways.** `config/models.json` lists endpoints (format, base URL, key variable,
extra headers) and their models (context size, capabilities, price per million tokens with cache
read and write prices). A model is `endpoint/model`; `roles` picks main, fast and deep. The three
formats map to `genai`'s OpenAI, OpenAI Responses and Anthropic adapters; Spade sets the full
target on every call, so any compatible server works, including local ones without a key. Model
ids, prices and base URLs in the shipped file come from models.dev (checked 2026-11-10); tiered
long-context prices are not modelled yet, so very long prompts are under-counted.

**Development** uses OpenCode Go (`OPENCODE_API_KEY`): its OpenAI-format endpoint for Kimi K3.1 Pro
and GLM-5.3, its Anthropic-format endpoint for Claude Haiku 5.5. Check that Go's terms allow its key
outside OpenCode before relying on it in production. The Go key is never shipped.

**CLI brains (planned).** Subscription models run as an ace provider session through the daemon,
with Spade's tools, skills and memory attached as an MCP server and the approval gate inside those
tools. Spade's roles can point at an endpoint or a CLI.

**SDK.** `genai` behind `spade-models`, compared with `aisdk` and `rig-core` on 2026-11-08 for
native Anthropic support (caching, thinking blocks across tool turns) and typed output. Spade owns
the agent loop, because the approval gate sits between a tool call and its run; swapping the SDK
only touches `spade-models`. Typed output is `generate::<T>()`: the schema comes from `schemars`,
and a reply that does not parse is an error, never a guess.

## Caching

Hit rate is input tokens read from the cache over all input tokens, per call. The first call of a
conversation always misses; every later call misses only on its new tail. The rules:

- The prompt is append-only. The tool list never changes within a conversation: deferred tools are
  revealed by `tool_search` results and called through a `call_tool` dispatcher, or by the
  endpoint itself where it declares `native-tool-search`.
- Per-turn content (matching memories, the time, room context) rides with the new message, never
  at the top. The skill index is frozen per conversation; `skill_load` returns skill text at the
  tail.
- One model per conversation; side jobs use the fast model with fixed templates.
- Byte-stable serialisation: tools sorted by name, fixed key order, no timestamps or random ids in
  the stable part.
- Anthropic: a long-lived breakpoint on the stable top and a short one on the tail. OpenAI: a stable
  `prompt_cache_key` per conversation.
- Compaction is rare and large and is the only time old tool results become stubs (see Compaction).
- Every call records input, cache-read, cache-write and output tokens; cost uses the cache prices,
  and the trace shows the hit rate per turn.

## Web search

`web_search` tries, in order, and takes the first that answers:

1. The model endpoint's own built-in search, where it has one (Anthropic Messages, OpenAI
   Responses), switched on in the model request. Billed per search by the provider.
2. The person's own SearXNG (`config/search.json`): free, no key, run by them. Its `settings.yml`
   must allow the `json` format.
3. Brave Search with the person's key, kept in the OS keychain (ADR 0116). Brave gives $5 of
   searches a month free.
4. If all of those fail, an ace agent on the cheapest available provider CLI (for example Claude
   Haiku through Claude Code) runs the search with that CLI's own web tool, on the person's
   subscription, and returns results with sources. Needs CLI brains.

Never by reading search engines' result pages directly: it breaks their terms, trips their bot
detection and can get the person's address blocked. `web_fetch` of a known URL is a plain HTTP
call Spade makes itself. `spade-search` (owner, 2026-11-10: SearXNG and Brave only for now) gives
clean title, address and snippet, drops repeats, caps results at 20, and skips a backend that
fails, times out or has no key, with a reason that never carries the key.

`spade-fetch` is `web_fetch`. Pages are untrusted and may try to steer the agent, so it fetches
http and https only, resolves the host itself and refuses loopback, private, link-local (cloud
metadata), CGNAT, multicast and reserved addresses and their IPv6 forms, then connects only to the
addresses it checked so DNS cannot swap them. Every redirect is checked again, at most five. It
reads at most 5 MB, and only HTML, text, JSON and XML (PDF later). HTML becomes light Markdown
from the main content (`main`, else `article`, else the body) without scripts, navigation,
page headers and footers, asides, forms or hidden elements. Text comes back a window at a time,
with the next offset when more remains. Errors are one short line and never quote the page.

## Compaction

Automatic (owner, 2026-11-10), plus a manual `/compact [focus]`. It rewrites only the conversation
part of the prompt, never the cached top (rules, bot instructions, tools, skill index), so each
compaction costs one cache miss and happens rarely.

- **When.** Measured from the endpoint's reported input tokens, against a budget: the smaller of the
  model's context size and a configurable cap. Compact at 75% of the budget, down to 35% (default
  settings). Only at a safe point: between turns, or mid-turn when a long agent turn would
  otherwise overflow; never between a tool call and its result.
- **How, cheapest first.** (1) Prune without a model call: old tool results become stubs that point
  into history, old images become their descriptions, repeated reads point back to the first.
  (2) Summarise with the conversation's own model by appending the request to the cached prompt,
  so its input is nearly all cache reads. (3) If summarising fails, drop the oldest turns behind a
  visible marker.
- **Kept word for word.** The cached top; the last turns and the latest message; pinned state: the
  goal, the todo list, unanswered approvals, running background jobs, skills in use, and every
  write already carried out with its duplicate-proof key, so it is never repeated.
- **Structured summary.** Typed output with goal, decisions, facts with sources, actions taken and
  their effects, open questions and next steps, and references (ids, links, paths). Each section
  is checked; the summary has its own token cap; a later compaction folds the previous summary in
  rather than stacking summaries.
- **Lossless storage.** A `context_compacted` event records the span covered, the summary and the
  token counts before and after, so a restart rebuilds the identical prompt. The full history
  stays in SQLite; `history_search` and `history_read` fetch exact old text on demand. Memory
  extraction runs on the compacted span first.
- **Smaller from the start.** Large tool output is stored as an artifact with a trimmed view and a
  handle to read more; exploration runs in sub-agents whose conclusions alone come back.
- **Seen by the person.** One quiet line: "Context compacted: 152k → 61k tokens", with the summary
  behind a link.
- **Tests.** Replay on the fake endpoint: compaction fires at the high mark and lands near the low
  one, the cached top is byte-identical before and after, recent turns and pinned state survive,
  every completed write is in the summary, and a restart rebuilds the same prompt.

## Features

1. **Spade, the main bot:** chat with streaming, voice, images and files; web search and deep
   research; canvases; image generation; background tasks that notify when done.
2. **Crews:** bots with a name, avatar, instructions, model, allowed connectors, knowledge files
   and their own memory. Versioned; shared by link, with a team or publicly; forkable.
3. **Group chat:** rooms with several people and bots; a lead bot can split work across a crew.
4. **Marketplace:** publish, browse, use, fork, rate and report bots; a permission list before
   use; safety review before listing. Paid bots later.
5. **Connectors:** see below.
6. **Reach Spade from:** ace desktop, web and iOS; later Telegram, WhatsApp, Slack and email.
7. **Automations:** schedules and triggers (email arrives, webhook, PR opened).
8. **ace control:** start, steer and read ace threads; review PRs; browser and computer use on
   the person's machines; daemon control. ace agents can ask Spade in return.
9. **Memory:** Spade's own, viewable, editable and deletable by the person.
10. **Safety and billing:** approvals for sending, buying and deleting; audit log; spending and
    rate limits; prompt-injection defence; plans and usage metering.

## Connectors

Most apps already publish MCP servers for chat assistants, so Spade reuses them. Source order,
first match wins:

1. **The app maker's own remote MCP server** (for example GitHub, Notion, Linear, Atlassian,
   Asana, Stripe, PayPal, HubSpot, Figma, Canva, Box, Vercel, Supabase, Neon, Cloudflare). The
   person signs in with OAuth. Some makers approve clients one by one; we apply. The current list
   needs a research pass before we rely on it.
2. **Our own connector** where none exists or triggers are needed: Gmail, Calendar and Drive;
   Microsoft 365; anything that must push events.
3. **An open-source MCP server, run unchanged** in a per-person sandbox, after a licence check.
   Its code is never copied into ours.
4. **An optional catch-all service** for the long tail, off by default: it holds the person's app
   logins and bills per call.

The MCP client needs OAuth with automatic client registration, the streamable HTTP transport and
the interactive app UI extension. Each catalogue entry records source, address, sign-in type,
licence, and a risk level per tool. Servers label tools read-only or destructive, but those
labels come from the server, so an unlabelled tool asks before it runs.

## Proposed algorithms

These wait for the owner's own algorithm and review.

**Agent turn.** Build context (bot instructions, recent messages plus a running summary,
retrieved memories, the bot's allowed tools, loaded on demand through tool search). Loop:
the model calls a tool, the approval gate checks it, it runs, the result is cut to a budget; stop
after K steps or a cost cap. Reads run; writes ask unless the person chose "always"; destructive
actions and payments always ask. Content from email and web pages is data, never instructions; a
tool call it triggers needs approval.

**Who speaks in group chat.** An @mention speaks. Otherwise a cheap router scores each bot
against the message and the room's topic; at most two bots above a threshold reply to a person's
message. Bot-to-bot replies stop after three hops, with a room cooldown and cost budget. Crew
mode: the lead plans, members work in parallel into a shared scratchpad, the lead posts one
answer.

**Memory.** Layers: the current chat, summaries of past chats, facts (with source, time and
confidence), and how-to preferences. Write: after a turn, extract candidate facts, compare each
with its nearest memories, and decide add, update, delete or ignore; newer wins and history is
kept. Read: meaning plus keyword search, weighted by recency and importance, re-ranked, within a
token budget. Scopes: person, bot, room and team; a marketplace bot never sees personal memory
unless granted.

**Connectors.** A manifest per connector (sign-in, scopes, actions with schemas, triggers, risk
per action). Tokens are encrypted at rest and decrypted only by the action runner.

**Marketplace trust.** A published bot is a frozen version; users stay pinned. New permissions
in an update need consent again. Ranking blends adjusted ratings with retention. Bots with write
access to connectors get a human review.

**Acting on machines.** Spade acts only on machines of the person who asked, never another
room member's, and only with the scopes that person turned on for Spade on that machine. Every
action is shown and logged on the daemon. Details in ace's draft ADR.

## Build order

1. **Chat core** (in progress; contract in [chat-core.md](chat-core.md)). Done: model layer,
   events, transcript, prompts, spending, store. Next: reply engine and local API, the daemon
   starting Spade, and Spade's screens in ace.
2. Agent loop, approval gate, and web search and page reading.
3. Using the person's machines through ace: threads, browser, computer use.
4. Memory.
5. Chat apps (Telegram, Discord and Slack first) with sender pairing; proactive schedules.
6. Connectors (Gmail, Calendar, Drive, GitHub, Notion first).
7. Crews and group chat; then the marketplace, and a hosted Spade for people without spare
   hardware.
