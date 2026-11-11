# Spade

Spade is ace's cloud agent: a main bot, crews of bots people make and share, group chats between
people and bots, a bot marketplace, connectors to other apps, and its own memory. It acts on a
person's machines through their ace daemons. The design and the decisions so far are in
[docs/design.md](docs/design.md).

This repository is the backend, written in Rust. Spade's screens live in ace's own apps (React on
desktop and web, Swift on iOS). It lives in ace's repository at `spade/` and, like the rest of ace, is
Apache-2.0.

## Getting started

Rust 1.95.0 is pinned in `rust-toolchain.toml`. If another Rust is first on your `PATH` (Homebrew's
`rust`, for example), put rustup's toolchain first so the pin applies:

```sh
export PATH="$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH"
cp .env.example .env
cargo run -p spade-server
curl localhost:3000/health   # {"ok":true,"version":"0.1.0","api":1}
```

## Commands

| Command                                                         | What it does                          |
| --------------------------------------------------------------- | ------------------------------------- |
| `cargo run -p spade-server`                                     | Start the server                      |
| `cargo test`                                                    | Unit tests and real-server HTTP tests |
| `cargo clippy --all-targets`                                    | Lint; warnings are errors             |
| `cargo fmt --all`                                               | Format                                |
| `cargo run -p spade-models --example ask -- [model] "question"` | One live model call (spends quota)    |

## Layout

```
crates/
  spade-models/    endpoints and models, chat, typed output, streaming, cache counts
  spade-core/      pure logic: events, transcript, prompts, spending, checkpoints, titles
  spade-store/     SQLite: conversations, event log, spending ledger
  spade-keys/      endpoint API keys in the OS keychain (ADR 0119)
  spade-search/    web search: your own SearXNG, then Brave with your key
  spade-ace/       ace's tools (MCP client of the daemon) and skill library (skills.request)
  spade-fetch/     web_fetch: one page as readable text, refusing local and private addresses
  spade-server/    local API and reply engine (in progress)
  spade-testkit/   test-only fake model endpoint (all three formats)
config/
  models.json      the model catalogue, read at startup
  search.json      search backends, tried in order
docs/
  design.md        features, architecture, decisions, build order
  chat-core.md     step 1 contract: events, API, live stream, spending
```

## Settings

| Variable                                   | Default              | Meaning                                                                               |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------- |
| `SPADE_LISTEN`                             | `127.0.0.1:3000`     | Address to listen on (loopback)                                                       |
| `RUST_LOG`                                 | `info`               | Log filter                                                                            |
| `SPADE_MODEL_CATALOG`                      | `config/models.json` | The model catalogue file                                                              |
| `SPADE_ACE_HOME`                           | set by the service   | ace's home: Spade finds the daemon from its `daemon-endpoint` and `daemon-token`      |
| `SPADE_ACE_MCP_URL`, `SPADE_ACE_MCP_TOKEN` | unset                | Development only: ace's MCP endpoint and a bearer, overriding `SPADE_ACE_HOME`        |
| `SPADE_ACE_URL`, `SPADE_ACE_TOKEN`         | unset                | Development only: the daemon's WebSocket and local token, for skills                  |
| Each endpoint's `key.env`                  |                      | That endpoint's key when it is not in the OS keychain, for example `OPENCODE_API_KEY` |

## Models

Spade calls any endpoint that speaks one of three formats: **OpenAI Chat Completions**
(`openai-chat`: OpenAI and every OpenAI-compatible server, such as OpenRouter, Groq, Ollama or vLLM),
**OpenAI Responses** (`openai-responses`) or **Anthropic Messages** (`anthropic`).

`config/models.json`, read at startup, lists the endpoints (id, name, format, base URL, the
key, optional extra headers) and each endpoint's models (id,
name, context size, capabilities such as `tools`, `images` or `native-tool-search`, and an optional
price per million tokens, including cache read and write prices). Models are named
`endpoint/model`, for example `anthropic/claude-sonnet-5-5`; `roles` sets the main, fast and deep
models. Keys live in the OS keychain (ADR 0119): Spade reads the keychain first, then the variable named in `key.env` (how a headless machine runs it). `"key": {}` means keychain only; an endpoint without `key` needs none (a local server). To add an endpoint, add an entry
and restart; nothing is recompiled.

The shipped file lists OpenCode Go (the development default), Anthropic, OpenAI, Google Gemini,
Moonshot and Z.AI, with model ids and prices from models.dev. Spade checks the file at startup and
refuses to start on any problem (unknown fields, duplicate or malformed ids, a bad URL or key name,
a negative price, a role that names nothing), listing every problem it found.

## How it runs

Spade runs on the person's own machine beside the ace daemon. Today the server runs on its own
(`cargo run -p spade-server`); the ace daemon will start and stop it. It stops cleanly on SIGTERM,
finishing open requests, and listens on loopback only.
