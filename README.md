# ace

ace is an agentic coding environment for running local coding-agent CLIs through one web, desktop, and remote-control workspace.

It starts provider CLIs behind a shared server, normalizes their runtime events, and streams session state to the UI over WebSocket.

The project is actively developed and already used as a daily coding workspace. Expect regular improvements as provider CLIs and desktop release flows evolve.

## Providers

ace currently includes integrations for:

- Codex
- Claude
- Cursor
- Gemini
- GitHub Copilot
- OpenCode
- Pi

Provider CLIs are installed and authenticated separately. ace does not replace provider accounts or provider-specific auth flows.

Provider-specific features are implemented natively where ace can expose them cleanly. Codex currently has the deepest native integration, including plugins, skills, image generation, and Browser Use inside ace's in-app browser. More provider-specific capabilities are coming across Claude, Cursor, Gemini, GitHub Copilot, OpenCode, and Pi.

See [FEATURES.md](./FEATURES.md) for the current feature map.

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Install and sign in to at least one supported provider CLI:

Examples:

- Codex: `codex login`
- Claude: `claude auth login`
- Gemini: install Gemini CLI and sign in
- Cursor: install `cursor-agent`
- GitHub Copilot: configure through ace app settings; availability is checked through the Copilot runtime
- OpenCode: install `opencode`
- Pi: install the Pi CLI, for example `npm install -g @mariozechner/pi-coding-agent`

3. Check local setup:

```bash
bun apps/server/src/bin.ts doctor
```

4. Start the app:

```bash
bun dev:web
```

This starts the web app and local server together.

## Desktop Releases

The Electron desktop app lives in `apps/desktop`.

Current desktop release state:

- macOS release artifacts are available.
- Windows and Linux packaging are part of the release workflow but need more real-device validation before production use.
- macOS signing/notarization and Windows signing require maintainer-owned signing credentials.

Generated release artifacts should stay out of git. Use ignored release directories such as `release/` or `release-mac-*/`.

## Mobile

The mobile app is in development in `apps/mobile`. It is part of the ace workspace direction for remote supervision and companion workflows, but the web and desktop apps are the primary daily-use surfaces today.

## CLI

The `ace` CLI can start/open the app, manage the daemon, diagnose provider setup, control telemetry, inspect terminals, and manage local/remote runtime state.

Quick examples:

```bash
# Open the app (reuses or starts daemon)
ace web

# Check local setup
ace doctor

# Start daemon in background
ace daemon start

# Stop daemon (same as `ace daemon stop`)
ace stop

# Restart daemon
ace daemon restart

# Telemetry and runtime controls
ace telemetry off
ace telemetry status
ace daemon start --telemetry on

# Managed terminals
ace terminal list
```

Full CLI guide with first-run setup, diagnostics, telemetry/privacy controls, terminal management, remote pairing, troubleshooting, and automation examples:

- [docs/cli.md](./docs/cli.md)

## Development

Requirements:

- Bun `1.3.9` or compatible with `package.json`
- Node `24.13.1` or compatible with `package.json`
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
- `bun run test`

Before considering a change complete, run:

```bash
bun fmt
bun lint
bun typecheck
```

Use `bun run test` for tests. Do not use `bun test`; the repo scripts route tests through Turbo/Vitest.

## Architecture

- `apps/server` manages provider sessions, daemon lifecycle, CLI commands, and WebSocket routing.
- `apps/web` is the main React/Vite UI.
- `apps/desktop` wraps the app in Electron and owns native desktop lifecycle/update behavior.
- Provider runtime activity is projected into shared orchestration events for the client.
- Some internals are still Codex-first today, but the product and provider layer are designed to support multiple backends.

## Repo Structure

- `apps/web` - React/Vite UI
- `apps/server` - WebSocket server and provider/session orchestration
- `apps/desktop` - Electron desktop shell
- `apps/mobile` - React Native / Expo mobile app
- `apps/marketing` - marketing site
- `apps/relay` - relay app
- `packages/contracts` - shared schemas and protocol types
- `packages/shared` - shared runtime utilities

## Contributing

Small reliability, performance, cross-platform, and docs improvements are the easiest contributions to review. Open an issue before large features, provider integrations, or protocol changes.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License And Attribution

ace is released under the MIT License.

This project began as a fork of T3 Code by T3 Tools Inc. and is now maintained as ace by arpan404.
