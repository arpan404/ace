# ace

ace is a minimal web GUI for coding agents.

It runs local provider CLIs behind a shared server, then streams session events to the UI over WebSocket.

ace is multi-provider. The repo currently includes provider integrations for:

- Codex
- Claude
- Cursor
- Gemini
- GitHub Copilot
- OpenCode

This project is still early and changing quickly.

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Install and sign in to at least one supported provider CLI.

Examples:

- Codex: `codex login`
- Claude: `claude auth login`
- Gemini: install Gemini CLI and sign in
- Cursor: install `cursor-agent`

3. Start the app:

```bash
bun dev:web
```

This starts the web app and local server together.

## Development

Requirements:

- `bun`
- `node`
- at least one supported provider CLI installed locally

Common commands:

```bash
bun dev:web
```

- `bun dev` - full dev runner
- `bun dev:web` - web app + server
- `bun dev:server` - server only
- `bun dev:desktop` - desktop app
- `bun dev:mobile` - mobile app
- `bun dev:marketing` - marketing site
- `bun fmt`
- `bun lint`
- `bun typecheck`

Before considering a change complete, run:

```bash
bun fmt
bun lint
bun typecheck
```

## Architecture

- `apps/server` manages provider sessions and exposes the app over WebSocket
- `apps/web` is the main React/Vite UI
- provider runtime activity is projected into shared orchestration events for the client
- some internals are still Codex-specific today, but the product and provider layer are designed to support multiple backends

## Repo Structure

- `apps/web` - React/Vite UI
- `apps/server` - WebSocket server and provider/session orchestration
- `apps/desktop` - Electron desktop shell
- `apps/mobile` - React Native / Expo mobile app
- `apps/marketing` - marketing site
- `apps/relay` - relay app
- `packages/contracts` - shared schemas and protocol types
- `packages/shared` - shared runtime utilities

## Notes

- The server is the integration point for provider CLIs.
- The web app consumes server-pushed orchestration events rather than talking to providers directly.
- For contribution details, see [CONTRIBUTING.md](./CONTRIBUTING.md).

> Attribution: ace is a fork of T3 Code by T3 Tools Inc. and is released under the MIT License, copyright (c) 2026 arpan404.
