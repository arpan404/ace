# Spade design

Date: 2026-11-08. Status: draft. Decisions marked **decided** are the owner's; everything else
is a proposal waiting for the owner's review.

## What Spade is

A cloud agent with ace as its front end. People talk to Spade, the main bot, and to bots they or
others made. Spade works across their apps through connectors, remembers what matters, and acts
on their machines through their ace daemons: it starts and steers coding agents, drives the
browser and computer use, and controls the daemon.

## Decisions

| Decision                                                                                                                    | Status   |
| --------------------------------------------------------------------------------------------------------------------------- | -------- |
| The backend is Rust, in ace's repository at `spade/`, Apache-2.0 like the rest of ace                                       | decided  |
| It runs on Linux VMs (native binary, systemd), not Workers or containers                                                    | decided  |
| Rust is the backend only; Spade's screens are ace's React (desktop, web) and Swift (iOS)                                    | decided  |
| Spade acts on a person's connected daemons and devices: controls them and the daemon                                        | decided  |
| Cloud first; a local-only Spade comes later                                                                                 | decided  |
| How Spade reaches daemons: through ace's relay with a Spade grant (ace draft ADR, `docs/adr/drafts/spade-daemon-access.md`) | proposed |
| Connectors reuse existing MCP servers before we write our own (see Connectors)                                              | proposed |
| Postgres with pgvector for data and memory; object storage for files                                                        | proposed |
| Spade's own models go through OpenRouter for now; Claude models directly may come later                                     | decided  |
| Development and internal testing call models with an OpenCode Go API key                                                    | decided  |
| Model access uses the `genai` crate behind Spade's own `spade-models` crate (see Models)                                    | decided  |
| The model list is curated: the current model of each family worth running, nothing older                                    | decided  |

## Shared with ace

Spade must speak ace's protocols exactly. Each has one source of truth in ace and is checked
from Rust with test vectors recorded from ace's TypeScript:

- **Encrypted channel:** `Noise_XX_25519_ChaChaPoly_SHA256` plus ace's prologue and flow credit
  (`packages/secure-channel`). Rust side: `snow`.
- **Account grants:** Ed25519, base64url claims and signature (`packages/account-grant`). Rust
  side: `ed25519-dalek`.
- **Wire messages:** ace's Zod schemas are exported to JSON Schema (`tools/protocol-docs`) and
  Rust types are generated from that. A check fails when the generated types are stale. Nobody
  keeps two copies by hand.

## Crates

Created when their first code lands.

| Crate            | Job                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `spade-server`   | HTTP server, config, wiring (exists)                                                                                        |
| `spade-core`     | Pure logic, no I/O: agent turn loop, approval gate, group chat turn-taking, memory decisions. Compiles natively and to Wasm |
| `spade-protocol` | Types generated from ace's schemas, plus Spade's own                                                                        |
| `spade-ace`      | Reaches a person's daemons through the relay: Noise, grants, calls                                                          |
| `spade-models`   | Model catalogue, gateways, chat, typed output, streaming (exists)                                                           |
| `spade-mcp`      | Connector catalogue and MCP client (`rmcp`)                                                                                 |
| `spade-memory`   | Memory storage and search                                                                                                   |

Rules carried over from ace: pure core with a thin I/O shell; clocks, ids, randomness and
network endpoints are injected; outside data is parsed before use; tests assert behaviour
through the public API with real edges (sockets, Postgres) where possible.

## Models

- **Production:** OpenRouter (`https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`). Spade's own
  key, on the VMs only.
- **Development:** OpenCode Go (`OPENCODE_API_KEY`). Most Go models take OpenAI-style requests at
  `https://opencode.ai/inference/go/openai/v1`. Some take Anthropic-style requests at
  `.../go/anthropic/v1` (MiniMax, Qwen, Claude Haiku) or Google-style at `.../go/google/v1beta`
  (Gemini), per the models.dev catalogue. The Go key is never deployed.
- **Later:** Claude models through Anthropic's own API.

The SDK must speak Anthropic's API natively (prompt caching, thinking blocks kept across tool
turns), plus OpenRouter and custom endpoints. Compared 2026-11-08 (all MIT):

| Crate           | Fit                                                                                                                                                                                     | Gaps                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `genai` 0.7     | Each provider's own protocol, Anthropic caching and thinking signatures, OpenRouter and OpenCode Go adapters, raw-frame access for lenient decoding, typed output through a JSON schema | Its OpenCode Go adapter is stale (old endpoint, sends only MiniMax to the Anthropic path); fixed with our own endpoint resolver |
| `aisdk` 0.6     | Closest to the Vercel AI SDK: `.schema::<T>()` typed output, tool macros, agent loop                                                                                                    | Young (263 stars); no Anthropic prompt caching; its OpenCode provider is Zen, not Go                                            |
| `rig-core` 0.46 | Most used                                                                                                                                                                               | Now centred on its coding-agent framework; frequent breaking releases; needs Rust 1.97                                          |

Proposal: `genai` behind `spade-models`, a small crate with Spade's own request and response types.
Typed output is `generate::<T>()`: the schema comes from `schemars`, and the reply is parsed with
serde into `T`; a parse failure is an error, never a guess. Spade owns the agent loop in
`spade-core`, not the SDK, because the approval gate has to sit between a tool call and its run.
Swapping the SDK later only touches `spade-models`.

**The catalogue** (`config/models.json`, read at startup, so changing models needs no rebuild; 2026-11-08):

| Model             | OpenRouter | OpenCode Go            | Anthropic |
| ----------------- | ---------- | ---------------------- | --------- |
| Claude Opus 5.5   | yes        |                        | yes       |
| Claude Sonnet 5.5 | yes        |                        | yes       |
| Claude Haiku 5.5  | yes        | yes (Anthropic format) | yes       |
| GPT-6.1 Sol       | yes        |                        |           |
| Gemini 4 Argon    | yes        | yes (Google format)    |           |
| Kimi K3.1 Pro     | yes        | yes                    |           |
| GLM-5.3           | yes        | yes                    |           |

Defaults per role: OpenRouter and Anthropic use Sonnet (main), Haiku (fast) and Opus (deep);
OpenCode Go uses Kimi K3.1 Pro, Haiku and Gemini 4 Argon. Left out on purpose: older
generations, Fable (cost), "-pro" and dated snapshots, preview and vision-experiment variants.

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

1. Foundation: this workspace (done), the ace ADR, generated protocol types, the Noise and grant
   test vectors, and `spade-ace` connecting to a daemon.
2. Spade one-to-one chat in ace, five connectors (Gmail, Calendar, Drive, GitHub, web search),
   memory v1, and the ace bridge (start a thread, watch it).
3. Crews, sharing by link, group chat.
4. Browser and computer use through daemons, automations, messaging channels.
5. Marketplace, moderation, billing.
6. Connector breadth and generic MCP. Local-only Spade later.
