# ace

ace is a fast, minimal GUI for coding agents (Codex, Claude, GitHub Copilot, Cursor, Gemini, and OpenCode).

> **Attribution:** ace is a fork of **T3 Code** by **T3 Tools Inc.** and is released under the MIT License, copyright (c) 2026 **arpan404**.

## Quick start

### 1. Install one provider CLI and sign in

- Codex: [Codex CLI](https://github.com/openai/codex) + `codex login`
- Claude: Claude Code + `claude auth login`
- GitHub Copilot: [GitHub Copilot CLI](https://docs.github.com/copilot)
- Cursor: [Cursor](https://cursor.com) + installed `cursor-agent`
- Gemini: [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- OpenCode: [OpenCode](https://opencode.ai/docs)

### 2. Run ace

```bash
npx ace
```

## Local development

```bash
bun install
bun dev
```

Useful commands:

- `bun dev:web` – web app only
- `bun dev:server` – server only
- `bun dev:desktop` – desktop app
- `bun fmt` / `bun lint` / `bun typecheck` – repo quality gates

OpenCode model behavior:

- Provider status fetches a featured OpenCode model snapshot (top 10 models).
- You can select from fetched OpenCode models and add custom OpenCode model slugs in Settings.

## Desktop app

Download the latest desktop build from [GitHub Releases](https://github.com/arpan404/ace/releases).

## Repo structure

- `apps/web` – React/Vite frontend
- `apps/server` – WebSocket server and provider/session orchestration
- `apps/desktop` – Electron shell
- `packages/contracts` – shared schemas and protocol types
- `packages/shared` – shared runtime utilities

## Project status

ace is still early-stage and changing quickly. Expect rough edges.

If you want to contribute, read [CONTRIBUTING.md](./CONTRIBUTING.md) first.
