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
ace serve
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
- `bun dev:mobile` – mobile app (Expo) + server + contracts
- `bun fmt` / `bun lint` / `bun typecheck` – repo quality gates

OpenCode model behavior:

- Provider status/model selection uses provider-grouped OpenCode catalog data.
- You can select from fetched OpenCode models and add custom OpenCode model slugs in Settings.

## Desktop app

Download the latest desktop build from [GitHub Releases](https://github.com/arpan404/ace/releases).
Packaged desktop builds auto-install the `ace` CLI in the background and register daemon autostart at login.

## Remote control modes

- **Desktop app**: manages local agents and multiple remote hosts.
- **URL/web mode**: manages a single remote host at a time.
- **Mobile app**: manages multiple hosts with host switching.
- **Initial authentication**: host-managed direct pairing links (QR or connection string) from **Settings → Devices**.

## Pairing and direct network access

ace remote access uses direct host networking plus one-time pairing sessions.

- Host creates one-time pairing links that include a claim endpoint and short-lived secret.
- Remote clients claim that pairing link, then wait for host approval.
- Approved devices receive authenticated session credentials for future reconnects.

Development defaults:

- Server default URL: `ws://127.0.0.1:3773/ws`
- For LAN/tailnet access, run the host with `ace serve --host <private-ip>`
- See [REMOTE.md](./REMOTE.md) for end-to-end remote setup details and security notes.

## Mobile app (Expo)

The mobile app lives in `apps/mobile` and connects to the same ace server over WebSocket RPC.

```bash
bun dev:mobile
```

or run separately:

```bash
bun dev:server
bun --cwd apps/mobile run dev
```

Mobile app highlights:

- Bottom tabs: **Projects**, **Threads**, **Browser**, **Editor**, **Terminal**
- Multi-host instances (manual + pairing QR/connection string import) with active-host switching
- Project dashboard with working/completed/pending agent counts

Default host behavior:

- The app infers your desktop host from Expo runtime and targets `ws://<desktop-host>:3773/ws`
- Override defaults with:
  - `EXPO_PUBLIC_ACE_HOST` (host/IP only)
  - `EXPO_PUBLIC_ACE_PORT` (port)
  - or full `EXPO_PUBLIC_ACE_WS_URL`

## Repo structure

- `apps/web` – React/Vite frontend
- `apps/mobile` – React Native/Expo mobile app
- `apps/server` – WebSocket server and provider/session orchestration
- `apps/desktop` – Electron shell
- `packages/contracts` – shared schemas and protocol types
- `packages/shared` – shared runtime utilities

## Project status

ace is still early-stage and changing quickly. Expect rough edges.

If you want to contribute, read [CONTRIBUTING.md](./CONTRIBUTING.md) first.
