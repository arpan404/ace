# Contributing

ace is an actively used coding workspace, so the best contributions are small, focused changes that improve reliability, performance, cross-platform behavior, or developer experience without expanding product scope unexpectedly.

## Before You Start

- Search existing issues and PRs.
- Open an issue first for non-trivial features, protocol changes, release changes, or large refactors.
- Keep one PR focused on one problem.
- Prefer the existing architecture and local helpers over new one-off patterns.

## What We Prioritize

- Provider/session reliability fixes.
- WebSocket reconnect, restart, and partial-stream correctness.
- Cross-platform desktop behavior on macOS, Windows, and Linux.
- Performance improvements with clear before/after reasoning.
- Tests for shared contracts, provider orchestration, updater behavior, and CLI flows.
- Clear docs for setup, troubleshooting, release, and provider requirements.

## What Usually Needs Discussion First

- New provider integrations.
- Changes to contracts or WebSocket protocol shape.
- Broad UI redesigns.
- Release/signing/update pipeline changes.
- Large rewrites or dependency swaps.

## Development Setup

Requirements:

- Bun `1.3.9` or compatible with `package.json`.
- Node `24.13.1` or compatible with `package.json`.
- At least one supported provider CLI if you are testing provider flows.

Install dependencies:

```bash
bun install
```

Run the app:

```bash
bun dev:web
```

Useful entry points:

```bash
bun dev:server
bun dev:desktop
bun dev:mobile
bun dev:marketing
ace doctor
```

## Required Checks

Before a PR is ready for review, run:

```bash
bun fmt
bun lint
bun typecheck
```

For tests, use:

```bash
bun run test
```

Do not run `bun test`; the repo uses `bun run test` so Turbo/Vitest run through the intended scripts.

For focused package tests:

```bash
bun run --filter=ace test -- open
bun run --filter=@ace/shared test -- processTermination
bun run --filter=@ace/desktop test -- updateState
```

## PR Guidelines

Include:

- What changed.
- Why the change is needed.
- How it was tested.
- Any known platform or provider limitations.

For UI changes, include screenshots or a short recording. For desktop, updater, or daemon changes, describe the platform tested.

## Architecture Notes

- `apps/server` owns provider orchestration, daemon commands, WebSocket routing, and CLI behavior.
- `apps/web` owns the React/Vite app and client-side session UX.
- `apps/desktop` owns the Electron shell, app updates, native dialogs, and desktop-specific lifecycle.
- `packages/contracts` is schema and protocol only.
- `packages/shared` contains runtime utilities consumed across packages and should use explicit subpath exports.

Provider runtime activity should be projected into orchestration/domain events server-side. The web app should not talk directly to provider CLIs.

## Security And Secrets

- Do not commit provider credentials, auth tokens, signing certificates, release artifacts, or local state.
- Redact logs before attaching them to issues or PRs.
- Keep generated desktop artifacts in ignored release directories.

## Maintainer Expectations

We may ask you to split a PR, add tests, reduce scope, or open an issue before continuing. That keeps reviews practical and preserves the reliability of the app people are already using day to day.
