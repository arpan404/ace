# Spade

Spade is ace's cloud agent: a main bot, crews of bots people make and share, group chats between
people and bots, a bot marketplace, connectors to other apps, and its own memory. It acts on a
person's machines through their ace daemons. The design and the decisions so far are in
[docs/design.md](docs/design.md).

This repository is the backend, written in Rust. Spade's screens live in ace's own apps (React on
desktop and web, Swift on iOS). It lives in ace's repository at `spade/`, under the
[Spade License](LICENSE). Spade's original material is proprietary and source-available, not open source. You may read it and run Official Builds, including for internal workplace use, make the copies those permissions reasonably need, and change User Settings as that license permits. Other copying, modification, redistribution, hosting as a service, and restricted commercial or competing use need prior written permission. Separately licensed material keeps its own license. This summary does not replace the license texts. The rest of ace is Apache-2.0.

## Getting started

The build, run, test and deployment instructions below are for the Licensor and developers
authorized in writing. They grant no permission to build or modify Spade.

Rust 1.95.0 is pinned in `rust-toolchain.toml`. If another Rust is first on your `PATH` (Homebrew's
`rust`, for example), put rustup's toolchain first so the pin applies:

```sh
export PATH="$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin:$PATH"
cp .env.example .env
cargo run -p spade-server
curl localhost:3000/health   # {"ok":true}
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
  spade-server/   HTTP server, config, serve loop (binary + library)
  spade-models/   model catalogue, gateways, chat, typed output, streaming
docs/
  design.md       features, architecture, decisions and open questions
```

Other crates (`spade-core`, `spade-protocol`, `spade-ace`, `spade-mcp`, `spade-memory`) are
created when their first code lands; see the design doc.

## Settings

| Variable                                                        | Default              | Meaning                                                       |
| --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `SPADE_LISTEN`                                                  | `127.0.0.1:3000`     | Address to listen on (loopback behind the proxy)              |
| `RUST_LOG`                                                      | `info`               | Log filter                                                    |
| `SPADE_MODEL_GATEWAY`                                           | `openrouter`         | `openrouter`, `opencode-go` (development only) or `anthropic` |
| `OPENROUTER_API_KEY` / `OPENCODE_API_KEY` / `ANTHROPIC_API_KEY` |                      | Key for the chosen gateway                                    |
| `SPADE_MODEL_ROOT`                                              |                      | Replaces the gateway's address (a proxy or test server)       |
| `SPADE_MODEL_CATALOG`                                           | `config/models.json` | The model catalogue file                                      |

## Models

Models are listed in `config/models.json`, read when Spade starts: one entry per model, with how
each gateway reaches it, and the default model per role (main, fast, deep) for each gateway.
Changing models means editing the file and restarting; nothing is recompiled. On the VMs, point
`SPADE_MODEL_CATALOG` at the deployed copy.

Keep the list short: the current model of each family worth running. Spade checks the file at
startup and refuses to start on any problem (unknown fields, duplicate ids, a default that is not
listed or that its gateway cannot run), listing every problem it found.

## Running on the Linux VMs

Build a release binary for the VM's architecture and run it under systemd. The server stops
cleanly on SIGTERM, finishing open requests. Keep `SPADE_LISTEN` on loopback and put TLS in a
reverse proxy in front of it.
