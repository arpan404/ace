# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

ace is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## React Code Quality

- Do not introduce new React Doctor Bugs, Performance, Security, or Accessibility diagnostics in `apps/web`. After React code changes, run `npx react-doctor@latest --verbose --diff` from `apps/web` and fix any new non-maintainability findings before committing.
- Treat React Doctor maintainability warnings as guidance, not a license to make mechanical edits that create new bugs or compiler bailouts. If removing `memo`, `useMemo`, `useCallback`, or `forwardRef` exposes new React Doctor Bugs or Performance diagnostics, revert that local edit and fix the underlying compiler-incompatible code first.
- Keep side effects tied to the event or subscription that causes them. Avoid using state plus `useEffect` as a delayed event handler; this creates extra renders and can run late or more than once.
- Avoid render-time reads or writes of refs except for narrow, intentional lazy initialization patterns that are verified against React Doctor. Ref-backed caches and imperative handles should be structured so React Compiler can still optimize the component.
- Prefer guard clauses in effects over nested conditional side effects. Effects should either synchronize with an external system, subscribe/unsubscribe, or perform cleanup; event work belongs in event handlers.
- When making React performance fixes, verify with the real tool instead of assuming a warning disappeared. Do not suppress React Doctor rules to pass a scan.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@ace/shared/git`) — no barrel index.

## Codex App Server (Important)

ace is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
