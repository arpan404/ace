# ace

ace is a minimal web GUI for coding agents.

It is currently optimized around Codex, with provider sessions managed by the server and streamed to the web app over WebSocket.

## Development

Requirements:

- `bun`
- `node`
- at least one supported agent CLI installed locally

Run locally:

```bash
bun install
bun dev:web
```

Useful commands:

- `bun dev` - full dev runner
- `bun dev:web` - web app + server
- `bun dev:server` - server only
- `bun fmt`
- `bun lint`
- `bun typecheck`

## Repo

- `apps/web` - React/Vite UI
- `apps/server` - WebSocket server and provider/session orchestration
- `packages/contracts` - shared schemas and protocol types
- `packages/shared` - shared runtime utilities

## Notes

- This repo is early and still changing quickly.
- Before considering a change complete, run `bun fmt`, `bun lint`, and `bun typecheck`.
- For contribution details, see [CONTRIBUTING.md](./CONTRIBUTING.md).

> Attribution: ace is a fork of T3 Code by T3 Tools Inc. and is released under the MIT License, copyright (c) 2026 arpan404.
